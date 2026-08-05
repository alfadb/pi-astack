//! atomic_file_v1: durable atomic create / replace / append / protected read.
//!
//! Durability residual (honest):
//! - Temp content is written with FILE_FLAG_WRITE_THROUGH and completed by FlushFileBuffers
//!   before publish. write_all_flush uses explicit 64 KiB WriteFile chunks.
//! - Publish is a same-volume atomic rename via MoveFileExW (no-replace for create; REPLACE for replace).
//! - MOVEFILE_WRITE_THROUGH documents only that a *copy+delete* style move flushes data before
//!   the call returns. On same-volume rename it does **not** claim directory-entry metadata flush
//!   or hardware FUA. Function name is retained; residual remains.
//! - Directory FlushFileBuffers is not a success path we depend on.
//! - NTFS/hardware FUA residual remains; we do not claim power-loss proof beyond the above.
//!
//! Publish contract: after MoveFileExW succeeds, the destination name is authoritative published.
//! Temp handle was DACL-verified before write; same-directory rename preserves the security
//! descriptor. Post-publish path re-verify is intentionally not performed (would turn a successful
//! publish into a misleading Err).
//!
//! Append mutex residual: predictable Global name remains DoS-able by same-machine squat under
//! weak DACL; acquire path fail-closes (DACL_INVALID / ACCESS_DENIED / BUSY). Same-token malice
//! remains out of contract.

use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_DIRECTORY,
    ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION, HANDLE,
    WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, DeleteFileW, FlushFileBuffers, GetFileSizeEx, MoveFileExW, ReadFile, WriteFile,
    CREATE_NEW, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
    FILE_GENERIC_READ, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_DATA, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
    READ_CONTROL, SYNCHRONIZE,
};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

use crate::pathutil::{
    ensure_local_ntfs, ensure_no_ancestor_reparse, get_final_path_name, hresult_to_win32,
    is_directory_attrs, normalize_user_path, parent_path, path_exists_no_reparse_leaf,
    paths_equal_win, query_attribute_tag, query_file_id_info, resolve_file_identity,
    to_extended_win32_path, to_wide, OwnedHandle, PathError, PathErrorCode,
};
use crate::protected_path::{require_private_rw_directory, require_private_rw_file, DaclError};
use crate::security::{
    build_protected_sd, expected_access_mask, verify_file_protected, verify_mutex_private_rw,
    CurrentTokenUser, ObjectClass, PathKind, ProtectedProfile,
};

/// Explicit multi-WriteFile chunk size so large payloads exercise multiple WriteFile rounds.
const WRITE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicErrorCode {
    InvalidPath,
    AncestorReparse,
    Reparse,
    UnsupportedVolume,
    NotDirectory,
    NotFile,
    NotFound,
    AccessDenied,
    IdentityChanged,
    DaclInvalid,
    IoFailed,
    TooLarge,
    Busy,
    Failed,
}

impl AtomicErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPath => "INVALID_PATH",
            Self::AncestorReparse => "ANCESTOR_REPARSE",
            Self::Reparse => "REPARSE",
            Self::UnsupportedVolume => "UNSUPPORTED_VOLUME",
            Self::NotDirectory => "NOT_DIRECTORY",
            Self::NotFile => "NOT_FILE",
            Self::NotFound => "NOT_FOUND",
            Self::AccessDenied => "ACCESS_DENIED",
            Self::IdentityChanged => "IDENTITY_CHANGED",
            Self::DaclInvalid => "DACL_INVALID",
            Self::IoFailed => "IO_FAILED",
            Self::TooLarge => "TOO_LARGE",
            Self::Busy => "BUSY",
            Self::Failed => "FAILED",
        }
    }
}

#[derive(Debug)]
pub struct AtomicError {
    pub code: AtomicErrorCode,
    pub detail: String,
}

impl AtomicError {
    fn new(code: AtomicErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

fn map_path(e: PathError) -> AtomicError {
    let code = match e.code {
        PathErrorCode::InvalidPath => AtomicErrorCode::InvalidPath,
        PathErrorCode::AncestorReparse => AtomicErrorCode::AncestorReparse,
        PathErrorCode::Reparse => AtomicErrorCode::Reparse,
        PathErrorCode::UnsupportedVolume => AtomicErrorCode::UnsupportedVolume,
        PathErrorCode::NotDirectory => AtomicErrorCode::NotDirectory,
        PathErrorCode::NotFile => AtomicErrorCode::NotFile,
        PathErrorCode::NotFound => AtomicErrorCode::NotFound,
        PathErrorCode::AccessDenied => AtomicErrorCode::AccessDenied,
        PathErrorCode::IdentityChanged => AtomicErrorCode::IdentityChanged,
    };
    AtomicError::new(code, e.detail)
}

fn map_dacl(e: DaclError) -> AtomicError {
    use crate::protected_path::DaclErrorCode;
    let code = match e.code {
        DaclErrorCode::InvalidPath => AtomicErrorCode::InvalidPath,
        DaclErrorCode::AncestorReparse => AtomicErrorCode::AncestorReparse,
        DaclErrorCode::Reparse => AtomicErrorCode::Reparse,
        DaclErrorCode::UnsupportedVolume => AtomicErrorCode::UnsupportedVolume,
        DaclErrorCode::NotDirectory => AtomicErrorCode::NotDirectory,
        DaclErrorCode::NotFile => AtomicErrorCode::NotFile,
        DaclErrorCode::NotFound => AtomicErrorCode::NotFound,
        DaclErrorCode::AccessDenied => AtomicErrorCode::AccessDenied,
        DaclErrorCode::IdentityChanged => AtomicErrorCode::IdentityChanged,
        DaclErrorCode::DaclInvalid => AtomicErrorCode::DaclInvalid,
        DaclErrorCode::InvalidProfile | DaclErrorCode::InvalidKind | DaclErrorCode::Failed => {
            AtomicErrorCode::Failed
        }
    };
    AtomicError::new(code, e.detail)
}

struct TempFile {
    path: String,
    handle: Option<OwnedHandle>,
}

impl TempFile {
    fn cleanup(&mut self) {
        if let Some(h) = self.handle.take() {
            drop(h);
        }
        // After successful publish, path is cleared — must not DeleteFileW("").
        if self.path.is_empty() {
            return;
        }
        let win32 = to_extended_win32_path(&self.path);
        let wide = to_wide(&win32);
        unsafe {
            let _ = DeleteFileW(PCWSTR(wide.as_ptr()));
        }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        self.cleanup();
    }
}

/// Parent directory handle held without FILE_SHARE_DELETE to block rename/junction swap (TOCTOU).
struct ParentGuard {
    _handle: OwnedHandle,
}

fn open_parent_private_rw_guard(parent: &str) -> Result<ParentGuard, AtomicError> {
    // Path-level verify first (closed error mapping).
    require_private_rw_directory(parent).map_err(map_dacl)?;

    let token =
        CurrentTokenUser::capture().map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;
    let win32 = to_extended_win32_path(parent);
    let wide = to_wide(&win32);
    let access = FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | SYNCHRONIZE.0;
    // Share READ|WRITE but NOT DELETE — blocks parent rename/delete while held.
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    let flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
    let opened = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            access,
            share,
            Some(ptr::null()),
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(flags.0),
            None,
        )
    };
    let handle = match opened {
        Ok(h) if !h.is_invalid() => h,
        Ok(_) => {
            return Err(AtomicError::new(
                AtomicErrorCode::AccessDenied,
                "parent guard CreateFileW returned INVALID_HANDLE_VALUE",
            ));
        }
        Err(err) => {
            let win32e = hresult_to_win32(err.code().0);
            if win32e == ERROR_ACCESS_DENIED.0 {
                return Err(AtomicError::new(
                    AtomicErrorCode::AccessDenied,
                    format!("parent guard open access denied (win32={win32e})"),
                ));
            }
            return Err(AtomicError::new(
                AtomicErrorCode::Failed,
                format!("parent guard open failed win32={win32e} ({err})"),
            ));
        }
    };

    if let Err(e) = (|| -> Result<(), AtomicError> {
        let tag = query_attribute_tag(handle).map_err(|e| {
            AtomicError::new(
                AtomicErrorCode::AccessDenied,
                format!("parent attribute: {e}"),
            )
        })?;
        use windows::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(AtomicError::new(
                AtomicErrorCode::Reparse,
                "parent is reparse while opening guard",
            ));
        }
        if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return Err(AtomicError::new(
                AtomicErrorCode::NotDirectory,
                "parent guard target is not a directory",
            ));
        }
        verify_file_protected(
            handle,
            PathKind::Directory,
            ProtectedProfile::PrivateRw,
            &token,
        )
        .map_err(|e| {
            AtomicError::new(
                AtomicErrorCode::DaclInvalid,
                format!("parent guard DACL: {e}"),
            )
        })?;
        let final_path = get_final_path_name(handle).map_err(map_path)?;
        if !paths_equal_win(&final_path, parent) {
            return Err(AtomicError::new(
                AtomicErrorCode::IdentityChanged,
                format!("parent guard final path diverged (input={parent}; final={final_path})"),
            ));
        }
        Ok(())
    })() {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(e);
    }

    Ok(ParentGuard {
        _handle: OwnedHandle(handle),
    })
}

fn unique_temp_path(parent: &str, dest_name: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    format!(
        r"{}\.{}.pi-astack-tmp.{}-{}.tmp",
        parent, dest_name, pid, nanos
    )
}

fn create_temp_private_rw(parent: &str, dest_name: &str) -> Result<TempFile, AtomicError> {
    let token =
        CurrentTokenUser::capture().map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;
    let mask = expected_access_mask(
        ObjectClass::File,
        PathKind::File,
        ProtectedProfile::PrivateRw,
    )
    .map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;

    // Retry CREATE_NEW a few times on name collision.
    for _ in 0..8 {
        let temp_path = unique_temp_path(parent, dest_name);
        let win32 = to_extended_win32_path(&temp_path);
        let wide = to_wide(&win32);
        let mut sd = build_protected_sd(&token, mask)
            .map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;
        let sa = sd.security_attributes();
        // DELETE for self-cleanup of temp; WRITE_THROUGH for durable content.
        let access =
            FILE_WRITE_DATA.0 | FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | SYNCHRONIZE.0 | 0x10000; // DELETE
        let flags = FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT;
        let created = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                access,
                FILE_SHARE_READ, // no WRITE/DELETE share on temp content handle
                Some(&sa as *const _),
                CREATE_NEW,
                FILE_FLAGS_AND_ATTRIBUTES(flags.0),
                None,
            )
        };
        let _ = sa;
        drop(sd);
        match created {
            Ok(h) if !h.is_invalid() => {
                verify_file_protected(h, PathKind::File, ProtectedProfile::PrivateRw, &token)
                    .map_err(|e| {
                        unsafe {
                            let _ = CloseHandle(h);
                            let _ = DeleteFileW(PCWSTR(wide.as_ptr()));
                        }
                        AtomicError::new(
                            AtomicErrorCode::DaclInvalid,
                            format!("temp file DACL verify failed: {e}"),
                        )
                    })?;
                return Ok(TempFile {
                    path: temp_path,
                    handle: Some(OwnedHandle(h)),
                });
            }
            Ok(_) => {
                return Err(AtomicError::new(
                    AtomicErrorCode::IoFailed,
                    "CreateFileW(CREATE_NEW) returned INVALID_HANDLE_VALUE",
                ));
            }
            Err(err) => {
                let win32 = hresult_to_win32(err.code().0);
                if win32 == ERROR_FILE_EXISTS.0 || win32 == ERROR_ALREADY_EXISTS.0 {
                    continue;
                }
                if win32 == ERROR_ACCESS_DENIED.0 {
                    return Err(AtomicError::new(
                        AtomicErrorCode::AccessDenied,
                        format!("temp CreateFileW access denied (win32={win32})"),
                    ));
                }
                return Err(AtomicError::new(
                    AtomicErrorCode::IoFailed,
                    format!("temp CreateFileW failed win32={win32} ({err})"),
                ));
            }
        }
    }
    Err(AtomicError::new(
        AtomicErrorCode::IoFailed,
        "unable to allocate unique temp file name",
    ))
}

fn write_all_flush(handle: HANDLE, data: &[u8]) -> Result<(), AtomicError> {
    let mut offset = 0usize;
    while offset < data.len() {
        let end = (offset + WRITE_CHUNK_BYTES).min(data.len());
        let chunk = &data[offset..end];
        let mut written: u32 = 0;
        unsafe {
            WriteFile(handle, Some(chunk), Some(&mut written), None).map_err(|e| {
                AtomicError::new(AtomicErrorCode::IoFailed, format!("WriteFile failed: {e}"))
            })?;
        }
        if written == 0 {
            return Err(AtomicError::new(
                AtomicErrorCode::IoFailed,
                "WriteFile wrote 0 bytes",
            ));
        }
        offset += written as usize;
    }
    unsafe {
        FlushFileBuffers(handle).map_err(|e| {
            AtomicError::new(
                AtomicErrorCode::IoFailed,
                format!("FlushFileBuffers failed: {e}"),
            )
        })?;
    }
    Ok(())
}

fn file_name_component(full: &str) -> Result<String, AtomicError> {
    let p = std::path::Path::new(full);
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AtomicError::new(AtomicErrorCode::InvalidPath, "path has no file name"))?;
    Ok(name.to_string())
}

fn map_move_error(win32: u32, err: &windows::core::Error, op: &str) -> AtomicError {
    if win32 == ERROR_ACCESS_DENIED.0 {
        return AtomicError::new(
            AtomicErrorCode::AccessDenied,
            format!("MoveFileExW({op}) access denied (win32={win32})"),
        );
    }
    if win32 == ERROR_DIRECTORY.0 {
        return AtomicError::new(
            AtomicErrorCode::NotFile,
            format!("MoveFileExW({op}) destination is a directory (win32={win32})"),
        );
    }
    if win32 == ERROR_PATH_NOT_FOUND.0 || win32 == ERROR_FILE_NOT_FOUND.0 {
        return AtomicError::new(
            AtomicErrorCode::NotFound,
            format!("MoveFileExW({op}) path not found (win32={win32})"),
        );
    }
    AtomicError::new(
        AtomicErrorCode::IoFailed,
        format!("MoveFileExW({op}) failed win32={win32} ({err})"),
    )
}

/// Atomic no-replace create. Returns Ok(true) created, Ok(false) collision, Err fail-closed.
/// Temp is created in the destination parent (same-dir publish). Prefer
/// `durable_atomic_create_file_with_temp_directory` when crash residue must not
/// land next to durable records/sources.
pub fn durable_atomic_create_file(path: &str, data: &[u8]) -> Result<bool, AtomicError> {
    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;
    let parent = parent_path(&full).map_err(map_path)?;
    // Hold parent without DELETE share for the whole temp+publish window.
    let _parent_guard = open_parent_private_rw_guard(&parent)?;

    if path_exists_no_reparse_leaf(&full).map_err(map_path)? {
        // Existing directory is a type error, not a create collision.
        if is_directory_attrs(&full).map_err(map_path)? {
            return Err(AtomicError::new(
                AtomicErrorCode::NotFile,
                "create destination exists as a directory",
            ));
        }
        return Ok(false);
    }

    let name = file_name_component(&full)?;
    let temp = create_temp_private_rw(&parent, &name)?;
    let handle = temp
        .handle
        .as_ref()
        .ok_or_else(|| AtomicError::new(AtomicErrorCode::Failed, "temp handle missing"))?
        .as_raw();
    write_all_flush(handle, data)?;
    publish_temp_no_replace(temp, &full)
}

/// Dual parent handle guards acquired in stable identity order (volume, file_id, path)
/// to avoid A/B reverse deadlock when two directories guard the same pair.
struct DualParentGuards {
    _first: ParentGuard,
    _second: Option<ParentGuard>,
}

fn open_dual_parent_guards(
    dest_parent: &str,
    staging_dir: &str,
) -> Result<DualParentGuards, AtomicError> {
    let dest_id = resolve_file_identity_as_dir(dest_parent)?;
    let stage_id = resolve_file_identity_as_dir(staging_dir)?;
    if dest_id.volume_hex != stage_id.volume_hex {
        return Err(AtomicError::new(
            AtomicErrorCode::UnsupportedVolume,
            format!(
                "dest parent and staging directory must share a volume (dest_vol={}; stage_vol={})",
                dest_id.volume_hex, stage_id.volume_hex
            ),
        ));
    }
    // Same directory identity → single guard.
    if dest_id.file_id_hex == stage_id.file_id_hex && paths_equal_win(dest_parent, staging_dir) {
        let g = open_parent_private_rw_guard(dest_parent)?;
        return Ok(DualParentGuards {
            _first: g,
            _second: None,
        });
    }
    // Stable sort by (file_id, path) so two callers never open in reverse order.
    let a_key = (dest_id.file_id_hex.clone(), dest_parent.to_string());
    let b_key = (stage_id.file_id_hex.clone(), staging_dir.to_string());
    let (first_path, second_path) = if a_key <= b_key {
        (dest_parent, staging_dir)
    } else {
        (staging_dir, dest_parent)
    };
    let first = open_parent_private_rw_guard(first_path)?;
    let second = open_parent_private_rw_guard(second_path)?;
    Ok(DualParentGuards {
        _first: first,
        _second: Some(second),
    })
}

fn resolve_file_identity_as_dir(
    directory: &str,
) -> Result<crate::pathutil::FileIdentity, AtomicError> {
    // resolve_directory_identity already enforces local NTFS / no reparse / directory.
    crate::pathutil::resolve_directory_identity(directory).map_err(map_path)
}

fn publish_temp_no_replace(mut temp: TempFile, dest_full: &str) -> Result<bool, AtomicError> {
    // Caller must already write_all_flush and leave content durable on the temp handle.
    if let Some(h) = temp.handle.take() {
        drop(h);
    }

    let src = to_extended_win32_path(&temp.path);
    let dst = to_extended_win32_path(dest_full);
    let src_w = to_wide(&src);
    let dst_w = to_wide(&dst);
    let moved = unsafe {
        MoveFileExW(
            PCWSTR(src_w.as_ptr()),
            PCWSTR(dst_w.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    match moved {
        Ok(()) => {
            temp.path.clear();
            Ok(true)
        }
        Err(err) => {
            let win32 = hresult_to_win32(err.code().0);
            if win32 == ERROR_ALREADY_EXISTS.0 || win32 == ERROR_FILE_EXISTS.0 {
                return Ok(false);
            }
            Err(map_move_error(win32, &err, "no-replace"))
        }
    }
}

/// Atomic no-replace create with an explicit same-volume protected staging directory.
///
/// - Destination parent + staging directory both require private_rw, local NTFS, no reparse.
/// - Both parents are handle-guarded (no DELETE share) for the full temp+publish window,
///   acquired in stable identity order to avoid reverse deadlock.
/// - Temp is CREATE_NEW under staging (private_rw + WRITE_THROUGH + FlushFileBuffers).
/// - Publish is MoveFileExW no-replace to destination; collision → Ok(false).
/// - Crash residue remains only under the caller-provided staging directory.
pub fn durable_atomic_create_file_with_temp_directory(
    path: &str,
    data: &[u8],
    temp_directory: &str,
) -> Result<bool, AtomicError> {
    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;
    let dest_parent = parent_path(&full).map_err(map_path)?;

    let staging = normalize_user_path(temp_directory).map_err(map_path)?;
    ensure_local_ntfs(&staging).map_err(map_path)?;
    ensure_no_ancestor_reparse(&staging).map_err(map_path)?;
    // Staging must itself be a private_rw directory (not a file path).
    require_private_rw_directory(&staging).map_err(map_dacl)?;

    let _guards = open_dual_parent_guards(&dest_parent, &staging)?;

    if path_exists_no_reparse_leaf(&full).map_err(map_path)? {
        if is_directory_attrs(&full).map_err(map_path)? {
            return Err(AtomicError::new(
                AtomicErrorCode::NotFile,
                "create destination exists as a directory",
            ));
        }
        return Ok(false);
    }

    let name = file_name_component(&full)?;
    let temp = create_temp_private_rw(&staging, &name)?;
    let handle = temp
        .handle
        .as_ref()
        .ok_or_else(|| AtomicError::new(AtomicErrorCode::Failed, "temp handle missing"))?
        .as_raw();
    write_all_flush(handle, data)?;
    publish_temp_no_replace(temp, &full)
}

/// Atomic replace. Concurrent readers see only old or new complete content.
pub fn durable_atomic_replace_file(path: &str, data: &[u8]) -> Result<(), AtomicError> {
    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;
    let parent = parent_path(&full).map_err(map_path)?;
    let _parent_guard = open_parent_private_rw_guard(&parent)?;

    // If destination exists as a directory, fail closed with NOT_FILE (not IO_FAILED).
    if path_exists_no_reparse_leaf(&full).map_err(map_path)?
        && is_directory_attrs(&full).map_err(map_path)?
    {
        return Err(AtomicError::new(
            AtomicErrorCode::NotFile,
            "replace destination exists as a directory",
        ));
    }

    let name = file_name_component(&full)?;
    let mut temp = create_temp_private_rw(&parent, &name)?;
    let handle = temp
        .handle
        .as_ref()
        .ok_or_else(|| AtomicError::new(AtomicErrorCode::Failed, "temp handle missing"))?
        .as_raw();
    write_all_flush(handle, data)?;
    if let Some(h) = temp.handle.take() {
        drop(h);
    }

    let src = to_extended_win32_path(&temp.path);
    let dst = to_extended_win32_path(&full);
    let src_w = to_wide(&src);
    let dst_w = to_wide(&dst);
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    // Retry sharing races when concurrent readers hold the destination briefly.
    // ACCESS_DENIED is retried briefly then mapped to AccessDenied (not IoFailed).
    let mut last_access_denied = false;
    let mut last_err = String::new();
    for attempt in 0..32 {
        let moved = unsafe { MoveFileExW(PCWSTR(src_w.as_ptr()), PCWSTR(dst_w.as_ptr()), flags) };
        match moved {
            Ok(()) => {
                temp.path.clear();
                // MoveFileEx success is authoritative published; no post-publish path reverify.
                return Ok(());
            }
            Err(err) => {
                let win32 = hresult_to_win32(err.code().0);
                last_err = format!("MoveFileExW(replace) failed win32={win32} ({err})");
                if win32 == ERROR_SHARING_VIOLATION.0 {
                    last_access_denied = false;
                    std::thread::sleep(std::time::Duration::from_millis(1 + attempt as u64));
                    continue;
                }
                if win32 == ERROR_ACCESS_DENIED.0 {
                    last_access_denied = true;
                    std::thread::sleep(std::time::Duration::from_millis(1 + attempt as u64));
                    continue;
                }
                return Err(map_move_error(win32, &err, "replace"));
            }
        }
    }
    if last_access_denied {
        return Err(AtomicError::new(
            AtomicErrorCode::AccessDenied,
            format!("{last_err} (exhausted ACCESS_DENIED retries)"),
        ));
    }
    Err(AtomicError::new(
        AtomicErrorCode::IoFailed,
        format!("{last_err} (exhausted retries)"),
    ))
}

struct AppendMutex {
    handle: HANDLE,
    released: bool,
}

impl AppendMutex {
    fn release(&mut self) {
        if !self.released && !self.handle.is_invalid() {
            unsafe {
                let _ = ReleaseMutex(self.handle);
                let _ = CloseHandle(self.handle);
            }
            self.released = true;
            self.handle = HANDLE::default();
        }
    }
}

impl Drop for AppendMutex {
    fn drop(&mut self) {
        self.release();
    }
}

fn acquire_append_mutex(
    identity_vol: &str,
    identity_fid: &str,
) -> Result<AppendMutex, AtomicError> {
    let token =
        CurrentTokenUser::capture().map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;
    let name = format!(
        r"Global\pi-astack-append-v1-{}-{}-{}",
        token.sid_hash8, identity_vol, identity_fid
    );
    let wide = to_wide(&name);
    let mask = expected_access_mask(
        ObjectClass::KernelMutex,
        PathKind::File,
        ProtectedProfile::PrivateRw,
    )
    .map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;
    let mut sd = build_protected_sd(&token, mask)
        .map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;
    let sa = sd.security_attributes();
    let created = unsafe { CreateMutexW(Some(&sa as *const _), false, PCWSTR(wide.as_ptr())) };
    let _ = sa;
    drop(sd);
    let handle = match created {
        Ok(h) if !h.is_invalid() => h,
        Ok(_) => {
            return Err(AtomicError::new(
                AtomicErrorCode::Failed,
                "CreateMutexW returned INVALID_HANDLE_VALUE",
            ));
        }
        Err(err) => {
            let win32 = hresult_to_win32(err.code().0);
            if win32 == ERROR_ACCESS_DENIED.0 {
                return Err(AtomicError::new(
                    AtomicErrorCode::AccessDenied,
                    format!("append mutex namespace denied (win32={win32})"),
                ));
            }
            return Err(AtomicError::new(
                AtomicErrorCode::Failed,
                format!("CreateMutexW failed win32={win32} ({err})"),
            ));
        }
    };

    // Always verify DACL before wait (new or existing).
    if let Err(e) = verify_mutex_private_rw(handle, &token) {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(AtomicError::new(
            AtomicErrorCode::DaclInvalid,
            format!("append mutex DACL invalid (squat/weak/foreign): {e}"),
        ));
    }

    // Bounded wait for multi-process append serialization.
    let wait = unsafe { WaitForSingleObject(handle, 30_000) };
    if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
        return Ok(AppendMutex {
            handle,
            released: false,
        });
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    if wait == WAIT_TIMEOUT {
        return Err(AtomicError::new(
            AtomicErrorCode::Busy,
            "append mutex wait timed out",
        ));
    }
    if wait == WAIT_FAILED {
        let err = unsafe { GetLastError() };
        return Err(AtomicError::new(
            AtomicErrorCode::Failed,
            format!("WaitForSingleObject failed win32={}", err.0),
        ));
    }
    Err(AtomicError::new(
        AtomicErrorCode::Failed,
        format!("WaitForSingleObject unexpected status={}", wait.0),
    ))
}

/// Single-record append under protected file + same-DACL named mutex; FlushFileBuffers.
pub fn durable_append_file(path: &str, data: &[u8]) -> Result<(), AtomicError> {
    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;
    let parent = parent_path(&full).map_err(map_path)?;
    require_private_rw_directory(&parent).map_err(map_dacl)?;
    require_private_rw_file(&full).map_err(map_dacl)?;
    let identity = resolve_file_identity(&full).map_err(map_path)?;

    let mut mutex = acquire_append_mutex(&identity.volume_hex, &identity.file_id_hex)?;

    let token =
        CurrentTokenUser::capture().map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;
    let win32 = to_extended_win32_path(&full);
    let wide = to_wide(&win32);
    let access = FILE_APPEND_DATA.0 | FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | SYNCHRONIZE.0;
    let flags = FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT;
    let opened = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE, // no DELETE share while appending
            Some(ptr::null()),
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(flags.0),
            None,
        )
    };
    let handle = match opened {
        Ok(h) if !h.is_invalid() => h,
        Ok(_) => {
            mutex.release();
            return Err(AtomicError::new(
                AtomicErrorCode::IoFailed,
                "append CreateFileW INVALID_HANDLE_VALUE",
            ));
        }
        Err(err) => {
            mutex.release();
            let win32e = hresult_to_win32(err.code().0);
            if win32e == ERROR_ACCESS_DENIED.0 {
                return Err(AtomicError::new(
                    AtomicErrorCode::AccessDenied,
                    format!("append open access denied (win32={win32e})"),
                ));
            }
            if win32e == ERROR_FILE_NOT_FOUND.0 || win32e == ERROR_PATH_NOT_FOUND.0 {
                return Err(AtomicError::new(
                    AtomicErrorCode::NotFound,
                    format!("append open not found (win32={win32e})"),
                ));
            }
            return Err(AtomicError::new(
                AtomicErrorCode::IoFailed,
                format!("append open failed win32={win32e} ({err})"),
            ));
        }
    };

    // Handle-level DACL + reparse + exact identity match with pre-mutex identity.
    if let Err(e) = (|| -> Result<(), AtomicError> {
        let tag = query_attribute_tag(handle).map_err(|e| {
            AtomicError::new(
                AtomicErrorCode::AccessDenied,
                format!("attribute query: {e}"),
            )
        })?;
        use windows::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(AtomicError::new(
                AtomicErrorCode::Reparse,
                "append target is reparse",
            ));
        }
        if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
            return Err(AtomicError::new(
                AtomicErrorCode::NotFile,
                "append target is directory",
            ));
        }
        verify_file_protected(handle, PathKind::File, ProtectedProfile::PrivateRw, &token)
            .map_err(|e| {
                AtomicError::new(AtomicErrorCode::DaclInvalid, format!("append DACL: {e}"))
            })?;
        let final_path = get_final_path_name(handle).map_err(map_path)?;
        if !paths_equal_win(&final_path, &full) {
            return Err(AtomicError::new(
                AtomicErrorCode::IdentityChanged,
                "append path identity diverged",
            ));
        }
        let open_id = query_file_id_info(handle).map_err(|e| {
            AtomicError::new(
                AtomicErrorCode::AccessDenied,
                format!("append file id: {e}"),
            )
        })?;
        if open_id.volume_hex != identity.volume_hex || open_id.file_id_hex != identity.file_id_hex
        {
            return Err(AtomicError::new(
                AtomicErrorCode::IdentityChanged,
                format!(
                    "append IDENTITY_CHANGED (pre vol={} id={}; open vol={} id={})",
                    identity.volume_hex,
                    identity.file_id_hex,
                    open_id.volume_hex,
                    open_id.file_id_hex
                ),
            ));
        }
        write_all_flush(handle, data)?;
        Ok(())
    })() {
        unsafe {
            let _ = CloseHandle(handle);
        }
        mutex.release();
        return Err(e);
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    mutex.release();
    Ok(())
}

#[derive(Clone)]
pub struct ProtectedFileReadResult {
    pub data: Vec<u8>,
    pub path: String,
    pub volume_serial_number: String,
    pub file_id: String,
    pub size: u64,
}

/// One-handle protected read with ceiling + identity stability.
pub fn read_protected_file(
    path: &str,
    max_bytes: u32,
) -> Result<ProtectedFileReadResult, AtomicError> {
    // maxBytes=0 is an invalid argument, not a size-ceiling hit.
    if max_bytes == 0 {
        return Err(AtomicError::new(
            AtomicErrorCode::InvalidPath,
            "maxBytes must be >= 1",
        ));
    }
    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;

    let token =
        CurrentTokenUser::capture().map_err(|e| AtomicError::new(AtomicErrorCode::Failed, e))?;

    let win32 = to_extended_win32_path(&full);
    let wide = to_wide(&win32);
    let access = FILE_GENERIC_READ.0 | READ_CONTROL.0 | SYNCHRONIZE.0;
    let flags = FILE_FLAG_OPEN_REPARSE_POINT;
    let opened = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            access,
            // FILE_SHARE_DELETE lets concurrent atomic replace (MoveFileEx REPLACE) succeed
            // while a long-held reader still holds the previous generation handle.
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            Some(ptr::null()),
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(flags.0),
            None,
        )
    };
    let handle = match opened {
        Ok(h) if !h.is_invalid() => h,
        Ok(_) => {
            return Err(AtomicError::new(
                AtomicErrorCode::IoFailed,
                "read CreateFileW INVALID_HANDLE_VALUE",
            ));
        }
        Err(err) => {
            let win32e = hresult_to_win32(err.code().0);
            // PATH_NOT_FOUND (missing parent) and FILE_NOT_FOUND both map to NotFound here;
            // TS DCC must re-verify the attestation directory so parent disappearance is not
            // treated as a clean-slate missing file.
            if win32e == ERROR_FILE_NOT_FOUND.0 || win32e == ERROR_PATH_NOT_FOUND.0 {
                return Err(AtomicError::new(
                    AtomicErrorCode::NotFound,
                    format!("file not found (win32={win32e})"),
                ));
            }
            if win32e == ERROR_ACCESS_DENIED.0 {
                return Err(AtomicError::new(
                    AtomicErrorCode::AccessDenied,
                    format!("read open access denied (win32={win32e})"),
                ));
            }
            return Err(AtomicError::new(
                AtomicErrorCode::IoFailed,
                format!("read open failed win32={win32e} ({err})"),
            ));
        }
    };
    let _guard = OwnedHandle(handle);

    let tag = query_attribute_tag(handle).map_err(|e| {
        AtomicError::new(
            AtomicErrorCode::AccessDenied,
            format!("attribute query: {e}"),
        )
    })?;
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(AtomicError::new(
            AtomicErrorCode::Reparse,
            "read target is reparse",
        ));
    }
    if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
        return Err(AtomicError::new(
            AtomicErrorCode::NotFile,
            "read target is directory",
        ));
    }
    verify_file_protected(handle, PathKind::File, ProtectedProfile::PrivateRw, &token)
        .map_err(|e| AtomicError::new(AtomicErrorCode::DaclInvalid, format!("read DACL: {e}")))?;
    let final_path = get_final_path_name(handle).map_err(map_path)?;
    if !paths_equal_win(&final_path, &full) {
        return Err(AtomicError::new(
            AtomicErrorCode::IdentityChanged,
            "read path identity diverged",
        ));
    }
    let id_before = query_file_id_info(handle)
        .map_err(|e| AtomicError::new(AtomicErrorCode::AccessDenied, format!("file id: {e}")))?;
    let mut size_i64: i64 = 0;
    unsafe {
        GetFileSizeEx(handle, &mut size_i64).map_err(|e| {
            AtomicError::new(
                AtomicErrorCode::IoFailed,
                format!("GetFileSizeEx failed: {e}"),
            )
        })?;
    }
    if size_i64 < 0 {
        return Err(AtomicError::new(
            AtomicErrorCode::IoFailed,
            "negative file size",
        ));
    }
    let size = size_i64 as u64;
    if size > u64::from(max_bytes) {
        return Err(AtomicError::new(
            AtomicErrorCode::TooLarge,
            format!("file size {size} exceeds maxBytes {max_bytes}"),
        ));
    }
    let mut buf = vec![0u8; size as usize];
    let mut offset = 0usize;
    while offset < buf.len() {
        let mut readn: u32 = 0;
        let slice = &mut buf[offset..];
        unsafe {
            ReadFile(handle, Some(slice), Some(&mut readn), None).map_err(|e| {
                AtomicError::new(AtomicErrorCode::IoFailed, format!("ReadFile failed: {e}"))
            })?;
        }
        if readn == 0 {
            return Err(AtomicError::new(
                AtomicErrorCode::IoFailed,
                "ReadFile returned 0 before complete",
            ));
        }
        offset += readn as usize;
    }

    // Post-read identity/size stability.
    let id_after = query_file_id_info(handle).map_err(|e| {
        AtomicError::new(AtomicErrorCode::AccessDenied, format!("post file id: {e}"))
    })?;
    if id_after.volume_hex != id_before.volume_hex || id_after.file_id_hex != id_before.file_id_hex
    {
        return Err(AtomicError::new(
            AtomicErrorCode::IdentityChanged,
            "file identity changed during read",
        ));
    }
    let mut size_after: i64 = 0;
    unsafe {
        GetFileSizeEx(handle, &mut size_after).map_err(|e| {
            AtomicError::new(
                AtomicErrorCode::IoFailed,
                format!("post GetFileSizeEx: {e}"),
            )
        })?;
    }
    if size_after as u64 != size {
        return Err(AtomicError::new(
            AtomicErrorCode::IdentityChanged,
            "file size changed during read",
        ));
    }

    Ok(ProtectedFileReadResult {
        data: buf,
        path: full,
        volume_serial_number: id_before.volume_hex,
        file_id: id_before.file_id_hex,
        size,
    })
}
