//! pi-astack Windows native N-API addon — core ABI v1 + versioned capabilities.
//!
//! Core ABI is frozen at 1. Capabilities (sorted):
//!   atomic_file_tempdir_v1, atomic_file_v1, protected_dacl_v1, retained_directory_lock_v1
//!
//! retained_directory_lock_v1 — zero-file Global named mutex with protected DACL:
//! - Directory is identity probe only (no sentinel/ADS, no DELETE lock handle).
//! - Mutex name: Global\pi-astack-retained-v1-<sidhash8>-<volumehex16>-<fileidhex32>
//! - CreateMutexW with current-TokenUser protected SD; verify owner/group/DACL on
//!   new and existing handles before Wait. Weak/foreign/squat → DACL_INVALID / ACCESS_DENIED
//!   (never BUSY).
//! - Owner-thread-local held set; WAIT_ABANDONED → acquired_after_abandon.
//!
//! Threat boundary: object owner can rewrite DACL; same-token malice is out of contract.

#![deny(clippy::all)]

mod atomic_file;
mod pathutil;
mod protected_path;
mod security;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::cell::RefCell;
use std::collections::HashSet;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, ERROR_ACCESS_DENIED,
    ERROR_ALREADY_EXISTS, HANDLE, WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, GetCurrentThread, GetCurrentThreadId, GetThreadId,
    ReleaseMutex, WaitForSingleObject,
};

use pathutil::{
    hresult_to_win32, paths_equal_win, resolve_directory_identity, to_wide, PathError,
    PathErrorCode,
};
use security::{
    build_protected_sd, expected_access_mask, verify_mutex_private_rw, CurrentTokenUser,
    ObjectClass, PathKind, ProtectedProfile,
};

const ADDON_ABI_V1: u32 = 1;
const PLATFORM: &str = "win32";
const ARCH: &str = "x64";
const NAPI_VERSION: u32 = 9;
const TARGET: &str = "win32-x64";
const CAPABILITY_ATOMIC_FILE_TEMPDIR_V1: &str = "atomic_file_tempdir_v1";
const CAPABILITY_ATOMIC_FILE_V1: &str = "atomic_file_v1";
const CAPABILITY_PROTECTED_DACL_V1: &str = "protected_dacl_v1";
const CAPABILITY_RETAINED_DIRECTORY_LOCK_V1: &str = "retained_directory_lock_v1";
const MUTEX_NAME_PREFIX: &str = r"Global\pi-astack-retained-v1-";

thread_local! {
  static THREAD_HELD: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

const SOURCE_COMMIT: &str = env!("PI_ASTACK_SOURCE_COMMIT");
const SOURCE_TREE_SHA256: &str = env!("PI_ASTACK_SOURCE_TREE_SHA256");
const BUILD_ID: &str = env!("PI_ASTACK_BUILD_ID");
const TOOLCHAIN_ID: &str = env!("PI_ASTACK_TOOLCHAIN_ID");
const BUILD_MODE: &str = env!("PI_ASTACK_BUILD_MODE");
const REPRODUCIBILITY: &str = env!("PI_ASTACK_REPRODUCIBILITY");
const NATIVE_TESTS: &str = env!("PI_ASTACK_NATIVE_TESTS");
const CLIPPY: &str = env!("PI_ASTACK_CLIPPY");
const BUILD_CONFIG_SHA256: &str = env!("PI_ASTACK_BUILD_CONFIG_SHA256");

/// Native fail-closed error codes for retained lock (fixed prefix closed set).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockErrorCode {
    InvalidPath,
    AncestorReparse,
    Reparse,
    UnsupportedVolume,
    NotDirectory,
    NotFound,
    AccessDenied,
    IdentityChanged,
    MutexFailed,
    MutexNamespaceDenied,
    DaclInvalid,
    WrongThread,
    Closed,
}

impl LockErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPath => "INVALID_PATH",
            Self::AncestorReparse => "ANCESTOR_REPARSE",
            Self::Reparse => "REPARSE",
            Self::UnsupportedVolume => "UNSUPPORTED_VOLUME",
            Self::NotDirectory => "NOT_DIRECTORY",
            Self::NotFound => "NOT_FOUND",
            Self::AccessDenied => "ACCESS_DENIED",
            Self::IdentityChanged => "IDENTITY_CHANGED",
            Self::MutexFailed => "MUTEX_FAILED",
            Self::MutexNamespaceDenied => "MUTEX_NAMESPACE_DENIED",
            Self::DaclInvalid => "DACL_INVALID",
            Self::WrongThread => "WRONG_THREAD",
            Self::Closed => "CLOSED",
        }
    }
}

fn lock_err(code: LockErrorCode, detail: impl AsRef<str>) -> Error {
    Error::from_reason(format!(
        "RETAINED_DIRECTORY_LOCK_{}: {}",
        code.as_str(),
        detail.as_ref()
    ))
}

fn dacl_err(code: protected_path::DaclErrorCode, detail: impl AsRef<str>) -> Error {
    Error::from_reason(format!(
        "PROTECTED_DACL_{}: {}",
        code.as_str(),
        detail.as_ref()
    ))
}

fn atomic_err(code: atomic_file::AtomicErrorCode, detail: impl AsRef<str>) -> Error {
    Error::from_reason(format!(
        "ATOMIC_FILE_{}: {}",
        code.as_str(),
        detail.as_ref()
    ))
}

fn map_path_to_lock(e: PathError) -> Error {
    let code = match e.code {
        PathErrorCode::InvalidPath => LockErrorCode::InvalidPath,
        PathErrorCode::AncestorReparse => LockErrorCode::AncestorReparse,
        PathErrorCode::Reparse => LockErrorCode::Reparse,
        PathErrorCode::UnsupportedVolume => LockErrorCode::UnsupportedVolume,
        PathErrorCode::NotDirectory => LockErrorCode::NotDirectory,
        PathErrorCode::NotFile => LockErrorCode::NotDirectory,
        PathErrorCode::NotFound => LockErrorCode::NotFound,
        PathErrorCode::AccessDenied => LockErrorCode::AccessDenied,
        PathErrorCode::IdentityChanged => LockErrorCode::IdentityChanged,
    };
    lock_err(code, e.detail)
}

struct OwnedMutex {
    handle: HANDLE,
    owner_thread_id: u32,
    owner_thread_handle: HANDLE,
    mutex_name: String,
    released: bool,
}

impl OwnedMutex {
    fn new(
        handle: HANDLE,
        owner_thread_id: u32,
        owner_thread_handle: HANDLE,
        mutex_name: String,
    ) -> Self {
        Self {
            handle,
            owner_thread_id,
            owner_thread_handle,
            mutex_name,
            released: false,
        }
    }

    fn as_raw(&self) -> HANDLE {
        self.handle
    }

    fn owner_thread_id(&self) -> u32 {
        self.owner_thread_id
    }

    fn clear_thread_held(&self) {
        let name = self.mutex_name.clone();
        THREAD_HELD.with(|held| {
            held.borrow_mut().remove(&name);
        });
    }

    fn owner_thread_valid(&self) -> bool {
        if self.owner_thread_handle.is_invalid() {
            return false;
        }
        let wait = unsafe { WaitForSingleObject(self.owner_thread_handle, 0) };
        if wait != WAIT_TIMEOUT {
            return false;
        }
        let tid = unsafe { GetThreadId(self.owner_thread_handle) };
        tid != 0 && tid == self.owner_thread_id
    }

    fn close_on_owner(&mut self) -> std::result::Result<(), LockErrorCode> {
        if self.released || self.handle.is_invalid() {
            self.released = true;
            self.handle = HANDLE::default();
            self.close_thread_handle();
            return Ok(());
        }
        let tid = unsafe { GetCurrentThreadId() };
        if tid != self.owner_thread_id {
            return Err(LockErrorCode::WrongThread);
        }
        if !self.owner_thread_valid() {
            return Err(LockErrorCode::MutexFailed);
        }
        if unsafe { ReleaseMutex(self.handle) }.is_err() {
            return Err(LockErrorCode::MutexFailed);
        }
        unsafe {
            let _ = CloseHandle(self.handle);
        }
        self.clear_thread_held();
        self.handle = HANDLE::default();
        self.close_thread_handle();
        self.released = true;
        Ok(())
    }

    fn close_thread_handle(&mut self) {
        if !self.owner_thread_handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.owner_thread_handle);
            }
            self.owner_thread_handle = HANDLE::default();
        }
    }
}

impl Drop for OwnedMutex {
    fn drop(&mut self) {
        if self.released || self.handle.is_invalid() {
            self.close_thread_handle();
            return;
        }
        let tid = unsafe { GetCurrentThreadId() };
        if tid != self.owner_thread_id {
            self.handle = HANDLE::default();
            self.owner_thread_handle = HANDLE::default();
            return;
        }
        if unsafe { ReleaseMutex(self.handle) }.is_ok() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
            self.clear_thread_held();
            self.handle = HANDLE::default();
            self.close_thread_handle();
            self.released = true;
        } else {
            self.handle = HANDLE::default();
            self.owner_thread_handle = HANDLE::default();
        }
    }
}

unsafe impl Send for OwnedMutex {}

fn duplicate_current_thread_handle() -> std::result::Result<HANDLE, LockErrorCode> {
    let mut out = HANDLE::default();
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            GetCurrentThread(),
            GetCurrentProcess(),
            &mut out,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok.is_err() || out.is_invalid() {
        return Err(LockErrorCode::MutexFailed);
    }
    Ok(out)
}

#[napi(object)]
#[derive(Clone)]
pub struct BuildIdentity {
    #[napi(js_name = "addon_abi")]
    pub addon_abi: u32,
    #[napi(js_name = "build_id")]
    pub build_id: String,
    #[napi(js_name = "source_commit")]
    pub source_commit: String,
    #[napi(js_name = "source_tree_sha256")]
    pub source_tree_sha256: String,
    #[napi(js_name = "toolchain_id")]
    pub toolchain_id: String,
    pub platform: String,
    pub arch: String,
    #[napi(js_name = "napi_version")]
    pub napi_version: u32,
    pub target: String,
    #[napi(js_name = "build_mode")]
    pub build_mode: String,
    pub reproducibility: String,
    #[napi(js_name = "native_tests")]
    pub native_tests: String,
    pub clippy: String,
    #[napi(js_name = "build_config_sha256")]
    pub build_config_sha256: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct RetainedDirectoryLockIdentity {
    pub path: String,
    #[napi(js_name = "volume_serial_number")]
    pub volume_serial_number: String,
    #[napi(js_name = "file_id")]
    pub file_id: String,
}

#[napi]
pub struct RetainedDirectoryLockLease {
    mutex: Option<OwnedMutex>,
    identity: RetainedDirectoryLockIdentity,
    acquired_after_abandon: bool,
}

#[napi]
impl RetainedDirectoryLockLease {
    #[napi(getter)]
    pub fn status(&self) -> String {
        if self.mutex.is_some() {
            "ACQUIRED".to_string()
        } else {
            "CLOSED".to_string()
        }
    }

    #[napi(getter)]
    pub fn identity(&self) -> RetainedDirectoryLockIdentity {
        self.identity.clone()
    }

    #[napi(getter, js_name = "acquired_after_abandon")]
    pub fn acquired_after_abandon(&self) -> bool {
        self.acquired_after_abandon
    }

    #[napi]
    pub fn close(&mut self) -> Result<()> {
        match self.mutex.as_mut() {
            None => Ok(()),
            Some(m) => match m.close_on_owner() {
                Ok(()) => {
                    self.mutex = None;
                    Ok(())
                }
                Err(LockErrorCode::WrongThread) => Err(lock_err(
                    LockErrorCode::WrongThread,
                    "close() must run on the owner thread",
                )),
                Err(LockErrorCode::MutexFailed) => Err(lock_err(
                    LockErrorCode::MutexFailed,
                    "ReleaseMutex/owner validation failed; lease remains held (not closed)",
                )),
                Err(other) => Err(lock_err(other, "close failed")),
            },
        }
    }

    #[napi(js_name = "assertIdentity")]
    pub fn assert_identity(&self) -> Result<()> {
        let mutex = self
            .mutex
            .as_ref()
            .ok_or_else(|| lock_err(LockErrorCode::Closed, "lease already closed"))?;

        let tid = unsafe { GetCurrentThreadId() };
        if tid != mutex.owner_thread_id() {
            return Err(lock_err(
                LockErrorCode::WrongThread,
                "assertIdentity must run on the owner thread",
            ));
        }
        if !mutex.owner_thread_valid() {
            return Err(lock_err(
                LockErrorCode::MutexFailed,
                "owner thread handle invalid or TID reuse suspected",
            ));
        }
        if mutex.as_raw().is_invalid() {
            return Err(lock_err(LockErrorCode::Closed, "mutex handle is invalid"));
        }

        let probed = resolve_directory_identity(&self.identity.path).map_err(map_path_to_lock)?;
        if probed.volume_hex != self.identity.volume_serial_number
            || probed.file_id_hex != self.identity.file_id
        {
            return Err(lock_err(
                LockErrorCode::IdentityChanged,
                format!(
                    "named directory identity changed (held vol={} id={}; now vol={} id={})",
                    self.identity.volume_serial_number,
                    self.identity.file_id,
                    probed.volume_hex,
                    probed.file_id_hex
                ),
            ));
        }
        if !paths_equal_win(&probed.canonical_path, &self.identity.path) {
            return Err(lock_err(
                LockErrorCode::IdentityChanged,
                format!(
                    "canonical path diverged (held={}; now={})",
                    self.identity.path, probed.canonical_path
                ),
            ));
        }
        Ok(())
    }
}

impl Drop for RetainedDirectoryLockLease {
    fn drop(&mut self) {
        self.mutex.take();
    }
}

#[allow(non_upper_case_globals)]
#[napi]
pub const addon_abi: u32 = ADDON_ABI_V1;

#[napi(js_name = "getBuildIdentity")]
pub fn get_build_identity() -> BuildIdentity {
    BuildIdentity {
        addon_abi: ADDON_ABI_V1,
        build_id: BUILD_ID.to_string(),
        source_commit: SOURCE_COMMIT.to_string(),
        source_tree_sha256: SOURCE_TREE_SHA256.to_string(),
        toolchain_id: TOOLCHAIN_ID.to_string(),
        platform: PLATFORM.to_string(),
        arch: ARCH.to_string(),
        napi_version: NAPI_VERSION,
        target: TARGET.to_string(),
        build_mode: BUILD_MODE.to_string(),
        reproducibility: REPRODUCIBILITY.to_string(),
        native_tests: NATIVE_TESTS.to_string(),
        clippy: CLIPPY.to_string(),
        build_config_sha256: BUILD_CONFIG_SHA256.to_string(),
    }
}

/// Sorted unique advertised capabilities (exact match required with runtime manifest).
#[napi(js_name = "getCapabilities")]
pub fn get_capabilities() -> Vec<String> {
    vec![
        CAPABILITY_ATOMIC_FILE_TEMPDIR_V1.to_string(),
        CAPABILITY_ATOMIC_FILE_V1.to_string(),
        CAPABILITY_PROTECTED_DACL_V1.to_string(),
        CAPABILITY_RETAINED_DIRECTORY_LOCK_V1.to_string(),
    ]
}

/// Try to acquire a retained directory lock via Global named mutex + protected DACL.
#[napi(js_name = "tryAcquireRetainedDirectoryLock")]
pub fn try_acquire_retained_directory_lock(
    directory_path: String,
) -> Result<Option<RetainedDirectoryLockLease>> {
    let probed = resolve_directory_identity(&directory_path).map_err(map_path_to_lock)?;
    let token = CurrentTokenUser::capture().map_err(|e| {
        lock_err(
            LockErrorCode::MutexFailed,
            format!("TokenUser capture failed: {e}"),
        )
    })?;

    let mutex_name = format!(
        "{}{}-{}-{}",
        MUTEX_NAME_PREFIX, token.sid_hash8, probed.volume_hex, probed.file_id_hex
    );
    let mutex_wide = to_wide(&mutex_name);

    let mask = expected_access_mask(
        ObjectClass::KernelMutex,
        PathKind::File,
        ProtectedProfile::PrivateRw,
    )
    .map_err(|e| lock_err(LockErrorCode::MutexFailed, format!("access mask: {e}")))?;
    let mut sd = build_protected_sd(&token, mask).map_err(|e| {
        lock_err(
            LockErrorCode::MutexFailed,
            format!("build protected SD failed: {e}"),
        )
    })?;
    let sa = sd.security_attributes();

    let created =
        unsafe { CreateMutexW(Some(&sa as *const _), false, PCWSTR(mutex_wide.as_ptr())) };
    // Keep SD alive across CreateMutexW.
    let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    // SECURITY_ATTRIBUTES is Copy; keep `sd` (relative buffer) alive until after CreateMutexW.
    let _ = sa;
    drop(sd);

    let handle = match created {
        Ok(h) if !h.is_invalid() => h,
        Ok(_) => {
            return Err(lock_err(
                LockErrorCode::MutexFailed,
                "CreateMutexW returned INVALID_HANDLE_VALUE",
            ));
        }
        Err(err) => {
            let win32 = hresult_to_win32(err.code().0);
            if win32 == ERROR_ACCESS_DENIED.0 {
                return Err(lock_err(
                    LockErrorCode::MutexNamespaceDenied,
                    format!("CreateMutexW namespace access denied (win32={win32})"),
                ));
            }
            return Err(lock_err(
                LockErrorCode::MutexFailed,
                format!("CreateMutexW failed win32={win32} ({err})"),
            ));
        }
    };

    // Handle-level DACL verify BEFORE Wait — both new and existing.
    // existing weak/foreign/squat → DACL_INVALID (not BUSY).
    if let Err(e) = verify_mutex_private_rw(handle, &token) {
        unsafe {
            let _ = CloseHandle(handle);
        }
        // Distinguish access-denied open of foreign object if we only got a handle somehow.
        let _ = already_exists;
        return Err(lock_err(
            LockErrorCode::DaclInvalid,
            format!("mutex protected DACL verify failed (squat/weak/foreign): {e}"),
        ));
    }

    let wait = unsafe { WaitForSingleObject(handle, 0) };
    let acquired_after_abandon = wait == WAIT_ABANDONED;
    if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
        let already_held = THREAD_HELD.with(|held| held.borrow().contains(&mutex_name));
        if already_held {
            unsafe {
                let _ = ReleaseMutex(handle);
                let _ = CloseHandle(handle);
            }
            return Ok(None);
        }

        THREAD_HELD.with(|held| {
            held.borrow_mut().insert(mutex_name.clone());
        });

        let recheck = resolve_directory_identity(&probed.canonical_path).map_err(|e| {
            unsafe {
                let _ = ReleaseMutex(handle);
                let _ = CloseHandle(handle);
            }
            THREAD_HELD.with(|held| {
                held.borrow_mut().remove(&mutex_name);
            });
            map_path_to_lock(PathError {
                code: e.code,
                detail: format!("post-acquire identity revalidation failed: {}", e.detail),
            })
        })?;
        if recheck.volume_hex != probed.volume_hex || recheck.file_id_hex != probed.file_id_hex {
            unsafe {
                let _ = ReleaseMutex(handle);
                let _ = CloseHandle(handle);
            }
            THREAD_HELD.with(|held| {
                held.borrow_mut().remove(&mutex_name);
            });
            return Err(lock_err(
                LockErrorCode::IdentityChanged,
                "directory identity changed between probe and mutex acquire",
            ));
        }

        // Re-verify DACL after acquire (defense in depth).
        if let Err(e) = verify_mutex_private_rw(handle, &token) {
            unsafe {
                let _ = ReleaseMutex(handle);
                let _ = CloseHandle(handle);
            }
            THREAD_HELD.with(|held| {
                held.borrow_mut().remove(&mutex_name);
            });
            return Err(lock_err(
                LockErrorCode::DaclInvalid,
                format!("post-acquire mutex DACL verify failed: {e}"),
            ));
        }

        let owner_thread_id = unsafe { GetCurrentThreadId() };
        let owner_thread_handle = match duplicate_current_thread_handle() {
            Ok(h) => h,
            Err(code) => {
                unsafe {
                    let _ = ReleaseMutex(handle);
                    let _ = CloseHandle(handle);
                }
                THREAD_HELD.with(|held| {
                    held.borrow_mut().remove(&mutex_name);
                });
                return Err(lock_err(code, "DuplicateHandle(GetCurrentThread) failed"));
            }
        };

        let identity = RetainedDirectoryLockIdentity {
            path: probed.canonical_path,
            volume_serial_number: probed.volume_hex,
            file_id: probed.file_id_hex,
        };
        return Ok(Some(RetainedDirectoryLockLease {
            mutex: Some(OwnedMutex::new(
                handle,
                owner_thread_id,
                owner_thread_handle,
                mutex_name,
            )),
            identity,
            acquired_after_abandon,
        }));
    }

    unsafe {
        let _ = CloseHandle(handle);
    }

    if wait == WAIT_TIMEOUT {
        return Ok(None);
    }
    if wait == WAIT_FAILED {
        let err = unsafe { GetLastError() };
        return Err(lock_err(
            LockErrorCode::MutexFailed,
            format!("WaitForSingleObject failed win32={}", err.0),
        ));
    }
    Err(lock_err(
        LockErrorCode::MutexFailed,
        format!("WaitForSingleObject unexpected status={}", wait.0),
    ))
}

// ── protected_dacl_v1 exports ──────────────────────────────────────────────

#[napi(js_name = "ensureProtectedDirectory")]
pub fn ensure_protected_directory(path: String) -> Result<String> {
    protected_path::ensure_protected_directory(&path).map_err(|e| dacl_err(e.code, e.detail))
}

#[napi(js_name = "setProtectedPath")]
pub fn set_protected_path(path: String, expected_kind: String, profile: String) -> Result<String> {
    protected_path::set_protected_path(&path, &expected_kind, &profile)
        .map_err(|e| dacl_err(e.code, e.detail))
}

#[napi(js_name = "verifyProtectedPath")]
pub fn verify_protected_path(
    path: String,
    expected_kind: String,
    profile: String,
) -> Result<String> {
    protected_path::verify_protected_path(&path, &expected_kind, &profile)
        .map_err(|e| dacl_err(e.code, e.detail))
}

// ── atomic_file_v1 exports ─────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone)]
pub struct ProtectedFileIdentity {
    pub path: String,
    #[napi(js_name = "volume_serial_number")]
    pub volume_serial_number: String,
    #[napi(js_name = "file_id")]
    pub file_id: String,
    pub size: f64,
}

#[napi(object)]
pub struct ProtectedFileRead {
    pub data: Buffer,
    pub identity: ProtectedFileIdentity,
}

#[napi(js_name = "durableAtomicCreateFile")]
pub fn durable_atomic_create_file(path: String, data: Buffer) -> Result<bool> {
    atomic_file::durable_atomic_create_file(&path, data.as_ref())
        .map_err(|e| atomic_err(e.code, e.detail))
}

/// atomic_file_tempdir_v1: no-replace create using an explicit same-volume staging directory.
/// Does not change durableAtomicCreateFile same-dir temp semantics.
#[napi(js_name = "durableAtomicCreateFileWithTempDirectory")]
pub fn durable_atomic_create_file_with_temp_directory(
    path: String,
    data: Buffer,
    temp_directory: String,
) -> Result<bool> {
    atomic_file::durable_atomic_create_file_with_temp_directory(
        &path,
        data.as_ref(),
        &temp_directory,
    )
    .map_err(|e| atomic_err(e.code, e.detail))
}

#[napi(js_name = "durableAtomicReplaceFile")]
pub fn durable_atomic_replace_file(path: String, data: Buffer) -> Result<()> {
    atomic_file::durable_atomic_replace_file(&path, data.as_ref())
        .map_err(|e| atomic_err(e.code, e.detail))
}

#[napi(js_name = "durableAppendFile")]
pub fn durable_append_file(path: String, data: Buffer) -> Result<()> {
    atomic_file::durable_append_file(&path, data.as_ref()).map_err(|e| atomic_err(e.code, e.detail))
}

#[napi(js_name = "readProtectedFile")]
pub fn read_protected_file(path: String, max_bytes: u32) -> Result<ProtectedFileRead> {
    let r = atomic_file::read_protected_file(&path, max_bytes)
        .map_err(|e| atomic_err(e.code, e.detail))?;
    Ok(ProtectedFileRead {
        data: Buffer::from(r.data),
        identity: ProtectedFileIdentity {
            path: r.path,
            volume_serial_number: r.volume_serial_number,
            file_id: r.file_id,
            size: r.size as f64,
        },
    })
}

// ── Path validation unit tests ─────────────────────────────────────────────
#[cfg(test)]
mod path_validation_tests {
    use super::pathutil::*;

    #[test]
    fn rejects_verbatim_prefix() {
        let e = validate_input_path(r"\\?\C:\Windows").unwrap_err();
        assert_eq!(e.code, PathErrorCode::InvalidPath);
    }

    #[test]
    fn rejects_device_prefix() {
        let e = validate_input_path(r"\\.\C:\Windows").unwrap_err();
        assert_eq!(e.code, PathErrorCode::InvalidPath);
    }

    #[test]
    fn rejects_leading_trailing_whitespace() {
        let e = validate_input_path(r" C:\Windows").unwrap_err();
        assert_eq!(e.code, PathErrorCode::InvalidPath);
        let e2 = validate_input_path(r"C:\Windows ").unwrap_err();
        assert_eq!(e2.code, PathErrorCode::InvalidPath);
    }

    #[test]
    fn rejects_relative() {
        let e = validate_input_path(r"relative\path").unwrap_err();
        assert_eq!(e.code, PathErrorCode::InvalidPath);
    }

    #[test]
    fn rejects_unc() {
        let e = validate_input_path(r"\\server\share\dir").unwrap_err();
        assert_eq!(e.code, PathErrorCode::UnsupportedVolume);
    }

    #[test]
    fn rejects_nul_device() {
        let e = validate_input_path(r"C:\foo\NUL").unwrap_err();
        assert_eq!(e.code, PathErrorCode::InvalidPath);
    }

    #[test]
    fn accepts_plain_drive_absolute_shape() {
        assert!(validate_input_path(r"C:\Windows").is_ok());
    }

    #[test]
    fn extended_path_form() {
        let e = to_extended_win32_path(r"C:\Windows");
        assert_eq!(e, r"\\?\C:\Windows");
    }

    #[test]
    fn unicode_case_compare() {
        assert!(paths_equal_win(r"C:\Windows", r"c:\windows"));
        assert!(paths_equal_win(r"C:\Foo", r"C:\foo"));
        assert!(!paths_equal_win(r"C:\Foo", r"C:\Bar"));
    }
}

// ── Mutex ownership tests (real OS threads) ────────────────────────────────
#[cfg(test)]
mod wrong_thread_drop_tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_mutex_name(tag: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!(
            r"Local\pi-astack-test-{}-{}-{}-{}",
            tag,
            std::process::id(),
            unsafe { GetCurrentThreadId() },
            nanos
        )
    }

    fn create_and_acquire(name: &str) -> HANDLE {
        let wide = to_wide(name);
        let handle =
            unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) }.expect("CreateMutexW");
        assert!(!handle.is_invalid(), "CreateMutexW invalid handle");
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        assert!(
            wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED,
            "expected acquire, got {}",
            wait.0
        );
        handle
    }

    fn wait_status(name: &str) -> windows::Win32::Foundation::WAIT_EVENT {
        let wide = to_wide(name);
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) }
            .expect("CreateMutexW open existing");
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        unsafe {
            if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
                let _ = ReleaseMutex(handle);
            }
            let _ = CloseHandle(handle);
        }
        wait
    }

    fn wait_status_on_other_thread(name: &str) -> windows::Win32::Foundation::WAIT_EVENT {
        let name = name.to_string();
        thread::spawn(move || wait_status(&name))
            .join()
            .expect("join waiter thread")
    }

    fn insert_tls(name: &str) {
        THREAD_HELD.with(|held| {
            assert!(held.borrow_mut().insert(name.to_string()), "TLS insert");
        });
    }

    fn tls_contains(name: &str) -> bool {
        THREAD_HELD.with(|held| held.borrow().contains(name))
    }

    fn make_owned(name: &str) -> OwnedMutex {
        let handle = create_and_acquire(name);
        insert_tls(name);
        let owner = unsafe { GetCurrentThreadId() };
        let th = duplicate_current_thread_handle().expect("dup thread");
        OwnedMutex::new(handle, owner, th, name.to_string())
    }

    #[test]
    fn owner_thread_drop_releases_mutex_and_tls() {
        let name = unique_mutex_name("owner-drop");
        let owned = make_owned(&name);
        drop(owned);

        assert!(!tls_contains(&name), "owner Drop must clear TLS held set");
        let wait = wait_status_on_other_thread(&name);
        assert!(
            wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED,
            "owner Drop must allow reacquire from non-owner thread, got {}",
            wait.0
        );
    }

    #[test]
    fn wrong_thread_explicit_close_returns_wrong_thread_and_keeps_lease() {
        let name = unique_mutex_name("wrong-close");
        let mut owned = make_owned(&name);
        let barrier = Arc::new(Barrier::new(2));
        let barrier_t = Arc::clone(&barrier);
        let result = thread::scope(|s| {
            let handle_ref = &mut owned;
            let j = s.spawn(move || {
                barrier_t.wait();
                handle_ref.close_on_owner()
            });
            barrier.wait();
            j.join().expect("join closer")
        });
        assert!(matches!(result, Err(LockErrorCode::WrongThread)));
        assert!(
            tls_contains(&name),
            "wrong-thread close must keep owner TLS"
        );
        assert!(!owned.handle.is_invalid(), "handle must remain open");
        assert!(!owned.released, "lease must remain unreleased");
        let wait = wait_status_on_other_thread(&name);
        assert_eq!(
            wait, WAIT_TIMEOUT,
            "mutex must still be owned after wrong-thread close"
        );

        owned
            .close_on_owner()
            .expect("owner close after wrong-thread attempt");
        assert!(!tls_contains(&name));
    }

    #[test]
    fn wrong_thread_drop_fail_closed_no_second_holder() {
        let name = unique_mutex_name("wrong-drop");
        let owned = make_owned(&name);

        let barrier = Arc::new(Barrier::new(2));
        let barrier_t = Arc::clone(&barrier);
        let t = thread::spawn(move || {
            barrier_t.wait();
            drop(owned);
        });
        barrier.wait();
        t.join().expect("join dropper");

        assert!(
            tls_contains(&name),
            "wrong-thread Drop must NOT clear owner TLS"
        );
        let wait = wait_status_on_other_thread(&name);
        assert_eq!(
            wait, WAIT_TIMEOUT,
            "wrong-thread Drop must not allow a second holder (got wait={})",
            wait.0
        );
    }

    #[test]
    fn owner_thread_close_then_drop_is_idempotent() {
        let name = unique_mutex_name("owner-close-drop");
        let mut owned = make_owned(&name);
        owned.close_on_owner().expect("close");
        owned.close_on_owner().expect("idempotent close");
        drop(owned);
        assert!(!tls_contains(&name));
        let wait = wait_status_on_other_thread(&name);
        assert!(wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED);
    }

    #[test]
    fn thread_exit_without_release_yields_wait_abandoned() {
        let name = unique_mutex_name("abandon");
        let barrier = Arc::new(Barrier::new(2));
        let barrier_t = Arc::clone(&barrier);
        let name_t = name.clone();
        let t = thread::spawn(move || {
            let handle = create_and_acquire(&name_t);
            barrier_t.wait();
            let _keep = handle;
        });
        barrier.wait();
        t.join().expect("join owner thread");
        let wait = wait_status(&name);
        assert_eq!(
            wait, WAIT_ABANDONED,
            "expected WAIT_ABANDONED after owner thread exit without Release, got {}",
            wait.0
        );
    }

    #[test]
    fn same_thread_tls_forces_busy_semantics() {
        let name = unique_mutex_name("tls-busy");
        insert_tls(&name);
        assert!(tls_contains(&name));
        let handle = create_and_acquire(&name);
        unsafe {
            let _ = ReleaseMutex(handle);
            let _ = CloseHandle(handle);
        }
        assert!(tls_contains(&name));
        THREAD_HELD.with(|held| {
            held.borrow_mut().remove(&name);
        });
    }
}

// ── Security unit tests ────────────────────────────────────────────────────
#[cfg(test)]
mod security_tests {
    use super::security::*;

    #[test]
    fn token_user_capture_and_hash() {
        let t = CurrentTokenUser::capture().expect("TokenUser");
        assert_eq!(t.sid_hash8.len(), 8);
        assert!(t.sid_hash8.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!t.sid_bytes().is_empty());
    }

    #[test]
    fn build_protected_sd_self_relative_nonempty() {
        let t = CurrentTokenUser::capture().expect("TokenUser");
        let mask = expected_access_mask(
            ObjectClass::File,
            PathKind::File,
            ProtectedProfile::PrivateRw,
        )
        .expect("mask");
        let mut sd = build_protected_sd(&t, mask).expect("build sd");
        let sa = sd.security_attributes();
        assert!(!sa.lpSecurityDescriptor.is_null());
        assert!(
            sa.nLength as usize
                >= std::mem::size_of::<windows::Win32::Security::SECURITY_ATTRIBUTES>()
        );
        let _ = sa;
    }

    #[test]
    fn package_rx_masks_exclude_write_delete() {
        let file_mask = expected_access_mask(
            ObjectClass::File,
            PathKind::File,
            ProtectedProfile::PackageRx,
        )
        .expect("file mask");
        let dir_mask = expected_access_mask(
            ObjectClass::File,
            PathKind::Directory,
            ProtectedProfile::PackageRx,
        )
        .expect("dir mask");
        // FILE_WRITE_DATA = 2, DELETE = 0x10000
        assert_eq!(
            file_mask & 0x2,
            0,
            "package_rx file must not grant FILE_WRITE_DATA"
        );
        assert_eq!(
            file_mask & 0x10000,
            0,
            "package_rx file must not grant DELETE"
        );
        assert_eq!(
            dir_mask & 0x2,
            0,
            "package_rx dir must not grant FILE_WRITE_DATA"
        );
        assert_eq!(
            dir_mask & 0x10000,
            0,
            "package_rx dir must not grant DELETE"
        );
    }

    #[test]
    fn kernel_mutex_package_rx_is_unreachable() {
        let err = expected_access_mask(
            ObjectClass::KernelMutex,
            PathKind::File,
            ProtectedProfile::PackageRx,
        )
        .expect_err("must refuse silent all-access mapping");
        assert!(err.contains("package_rx"), "err={err}");
    }

    #[test]
    fn profile_parse_closed_set() {
        assert!(ProtectedProfile::parse("private_rw").is_some());
        assert!(ProtectedProfile::parse("package_rx").is_some());
        assert!(ProtectedProfile::parse("other").is_none());
    }

    #[test]
    fn set_and_verify_private_then_package_rx_roundtrip() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("pi-astack-dacl-ut-{nanos}"));
        std::fs::create_dir_all(&base).expect("mkdir base");
        let dir = base.join("leaf");
        let dir_s = dir.to_string_lossy().to_string();
        // ensure private_rw leaf
        let canon = crate::protected_path::ensure_protected_directory(&dir_s).expect("ensure");
        crate::protected_path::verify_protected_path(&canon, "directory", "private_rw")
            .expect("verify private");
        // set package_rx
        crate::protected_path::set_protected_path(&canon, "directory", "package_rx")
            .expect("set package_rx");
        crate::protected_path::verify_protected_path(&canon, "directory", "package_rx")
            .expect("verify package_rx");
        // restore private_rw via owner path
        crate::protected_path::set_protected_path(&canon, "directory", "private_rw")
            .expect("restore private_rw");
        crate::protected_path::verify_protected_path(&canon, "directory", "private_rw")
            .expect("verify restored");
        let _ = std::fs::remove_dir_all(&base);
    }
}
