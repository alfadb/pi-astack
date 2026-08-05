//! protected_dacl_v1 path exports: ensure / set / verify.

use std::ptr;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND,
    ERROR_PATH_NOT_FOUND,
};
use windows::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING, READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
};

use crate::pathutil::{
    ensure_local_ntfs, ensure_no_ancestor_reparse, get_final_path_name, is_directory_attrs,
    normalize_user_path, parent_path, path_exists_no_reparse_leaf, paths_equal_win,
    query_attribute_tag, to_extended_win32_path, to_wide, OwnedHandle, PathError, PathErrorCode,
};
use crate::security::{
    build_protected_sd, expected_access_mask, set_protected_on_file_path, verify_file_protected,
    CurrentTokenUser, ObjectClass, PathKind, ProtectedProfile,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaclErrorCode {
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
    InvalidProfile,
    InvalidKind,
    Failed,
}

impl DaclErrorCode {
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
            Self::InvalidProfile => "INVALID_PROFILE",
            Self::InvalidKind => "INVALID_KIND",
            Self::Failed => "FAILED",
        }
    }
}

#[derive(Debug)]
pub struct DaclError {
    pub code: DaclErrorCode,
    pub detail: String,
}

impl DaclError {
    fn new(code: DaclErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

fn map_path(e: PathError) -> DaclError {
    let code = match e.code {
        PathErrorCode::InvalidPath => DaclErrorCode::InvalidPath,
        PathErrorCode::AncestorReparse => DaclErrorCode::AncestorReparse,
        PathErrorCode::Reparse => DaclErrorCode::Reparse,
        PathErrorCode::UnsupportedVolume => DaclErrorCode::UnsupportedVolume,
        PathErrorCode::NotDirectory => DaclErrorCode::NotDirectory,
        PathErrorCode::NotFile => DaclErrorCode::NotFile,
        PathErrorCode::NotFound => DaclErrorCode::NotFound,
        PathErrorCode::AccessDenied => DaclErrorCode::AccessDenied,
        PathErrorCode::IdentityChanged => DaclErrorCode::IdentityChanged,
    };
    DaclError::new(code, e.detail)
}

fn open_for_verify(win32_path: &str, is_dir: bool) -> Result<OwnedHandle, DaclError> {
    let wide = to_wide(win32_path);
    let access = FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | SYNCHRONIZE.0;
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    let mut flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if is_dir {
        flags |= FILE_FLAG_BACKUP_SEMANTICS;
    }
    let handle = unsafe {
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
    match handle {
        Ok(h) if !h.is_invalid() => Ok(OwnedHandle(h)),
        Ok(_) => Err(DaclError::new(
            DaclErrorCode::AccessDenied,
            "CreateFileW returned INVALID_HANDLE_VALUE",
        )),
        Err(err) => {
            let win32 = crate::pathutil::hresult_to_win32(err.code().0);
            if win32 == ERROR_FILE_NOT_FOUND.0 || win32 == ERROR_PATH_NOT_FOUND.0 {
                return Err(DaclError::new(
                    DaclErrorCode::NotFound,
                    format!("path does not exist (win32={win32})"),
                ));
            }
            if win32 == ERROR_ACCESS_DENIED.0 {
                return Err(DaclError::new(
                    DaclErrorCode::AccessDenied,
                    format!("CreateFileW access denied (win32={win32})"),
                ));
            }
            Err(DaclError::new(
                DaclErrorCode::AccessDenied,
                format!("CreateFileW failed win32={win32} ({err})"),
            ))
        }
    }
}

/// Open with WRITE_DAC | WRITE_OWNER for full owner/group/DACL convergence.
fn open_for_set_full(win32_path: &str, is_dir: bool) -> Result<OwnedHandle, DaclError> {
    let wide = to_wide(win32_path);
    let access =
        FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | WRITE_DAC.0 | WRITE_OWNER.0 | SYNCHRONIZE.0;
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    let mut flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if is_dir {
        flags |= FILE_FLAG_BACKUP_SEMANTICS;
    }
    let handle = unsafe {
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
    match handle {
        Ok(h) if !h.is_invalid() => Ok(OwnedHandle(h)),
        Ok(_) => Err(DaclError::new(
            DaclErrorCode::AccessDenied,
            "CreateFileW returned INVALID_HANDLE_VALUE",
        )),
        Err(err) => {
            let win32 = crate::pathutil::hresult_to_win32(err.code().0);
            if win32 == ERROR_FILE_NOT_FOUND.0 || win32 == ERROR_PATH_NOT_FOUND.0 {
                return Err(DaclError::new(
                    DaclErrorCode::NotFound,
                    format!("path does not exist (win32={win32})"),
                ));
            }
            if win32 == ERROR_ACCESS_DENIED.0 {
                return Err(DaclError::new(
                    DaclErrorCode::AccessDenied,
                    format!("CreateFileW WRITE_DAC|WRITE_OWNER access denied (win32={win32})"),
                ));
            }
            Err(DaclError::new(
                DaclErrorCode::AccessDenied,
                format!("CreateFileW failed win32={win32} ({err})"),
            ))
        }
    }
}

/// Open with WRITE_DAC only (fallback when WRITE_OWNER not available on handle).
fn open_for_set_dacl(win32_path: &str, is_dir: bool) -> Result<OwnedHandle, DaclError> {
    let wide = to_wide(win32_path);
    let access = FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | WRITE_DAC.0 | SYNCHRONIZE.0;
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    let mut flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if is_dir {
        flags |= FILE_FLAG_BACKUP_SEMANTICS;
    }
    let handle = unsafe {
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
    match handle {
        Ok(h) if !h.is_invalid() => Ok(OwnedHandle(h)),
        Ok(_) => Err(DaclError::new(
            DaclErrorCode::AccessDenied,
            "CreateFileW returned INVALID_HANDLE_VALUE",
        )),
        Err(err) => {
            let win32 = crate::pathutil::hresult_to_win32(err.code().0);
            if win32 == ERROR_FILE_NOT_FOUND.0 || win32 == ERROR_PATH_NOT_FOUND.0 {
                return Err(DaclError::new(
                    DaclErrorCode::NotFound,
                    format!("path does not exist (win32={win32})"),
                ));
            }
            if win32 == ERROR_ACCESS_DENIED.0 {
                return Err(DaclError::new(
                    DaclErrorCode::AccessDenied,
                    format!("CreateFileW WRITE_DAC access denied (win32={win32})"),
                ));
            }
            Err(DaclError::new(
                DaclErrorCode::AccessDenied,
                format!("CreateFileW failed win32={win32} ({err})"),
            ))
        }
    }
}

fn verify_handle_kind_and_final(
    handle: &OwnedHandle,
    full: &str,
    expected: PathKind,
) -> Result<(), DaclError> {
    let tag = query_attribute_tag(handle.as_raw()).map_err(|e| {
        DaclError::new(
            DaclErrorCode::AccessDenied,
            format!("attribute query failed: {e}"),
        )
    })?;
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(DaclError::new(
            DaclErrorCode::Reparse,
            "leaf reparse points / symlinks / junctions are rejected",
        ));
    }
    let is_dir = tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    match expected {
        PathKind::Directory if !is_dir => {
            return Err(DaclError::new(
                DaclErrorCode::NotDirectory,
                "target is not a directory",
            ));
        }
        PathKind::File if is_dir => {
            return Err(DaclError::new(
                DaclErrorCode::NotFile,
                "target is a directory, expected file",
            ));
        }
        _ => {}
    }
    let final_path = get_final_path_name(handle.as_raw()).map_err(map_path)?;
    if !paths_equal_win(&final_path, full) {
        return Err(DaclError::new(
            DaclErrorCode::IdentityChanged,
            format!("final path diverged (input={full}; final={final_path})"),
        ));
    }
    Ok(())
}

/// Hold parent without FILE_SHARE_DELETE while creating a protected leaf (TOCTOU).
struct ParentNoDeleteGuard {
    _handle: OwnedHandle,
}

fn open_parent_no_delete_guard(parent: &str) -> Result<ParentNoDeleteGuard, DaclError> {
    let win32 = to_extended_win32_path(parent);
    let wide = to_wide(&win32);
    let access = FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | SYNCHRONIZE.0;
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE; // no DELETE
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
            return Err(DaclError::new(
                DaclErrorCode::AccessDenied,
                "parent guard INVALID_HANDLE_VALUE",
            ));
        }
        Err(err) => {
            let win32e = crate::pathutil::hresult_to_win32(err.code().0);
            if win32e == ERROR_ACCESS_DENIED.0 {
                return Err(DaclError::new(
                    DaclErrorCode::AccessDenied,
                    format!("parent guard open access denied (win32={win32e})"),
                ));
            }
            return Err(DaclError::new(
                DaclErrorCode::Failed,
                format!("parent guard open failed win32={win32e} ({err})"),
            ));
        }
    };
    if let Err(e) = (|| -> Result<(), DaclError> {
        let tag = query_attribute_tag(handle).map_err(|e| {
            DaclError::new(
                DaclErrorCode::AccessDenied,
                format!("parent attribute: {e}"),
            )
        })?;
        use windows::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(DaclError::new(DaclErrorCode::Reparse, "parent is reparse"));
        }
        if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return Err(DaclError::new(
                DaclErrorCode::NotDirectory,
                "parent is not a directory",
            ));
        }
        let final_path = get_final_path_name(handle).map_err(map_path)?;
        if !paths_equal_win(&final_path, parent) {
            return Err(DaclError::new(
                DaclErrorCode::IdentityChanged,
                format!("parent final path diverged (input={parent}; final={final_path})"),
            ));
        }
        Ok(())
    })() {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(e);
    }
    Ok(ParentNoDeleteGuard {
        _handle: OwnedHandle(handle),
    })
}

/// Create leaf directory with private_rw protected DACL, or verify existing.
pub fn ensure_protected_directory(path: &str) -> Result<String, DaclError> {
    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;

    let token =
        CurrentTokenUser::capture().map_err(|e| DaclError::new(DaclErrorCode::Failed, e))?;
    let profile = ProtectedProfile::PrivateRw;
    let kind = PathKind::Directory;

    let exists = path_exists_no_reparse_leaf(&full).map_err(map_path)?;
    // Hold parent without DELETE share across leaf create (TOCTOU).
    let mut _parent_guard: Option<ParentNoDeleteGuard> = None;
    if !exists {
        let parent = parent_path(&full).map_err(map_path)?;
        ensure_local_ntfs(&parent).map_err(map_path)?;
        ensure_no_ancestor_reparse(&parent).map_err(map_path)?;
        if !path_exists_no_reparse_leaf(&parent).map_err(map_path)? {
            return Err(DaclError::new(
                DaclErrorCode::NotFound,
                format!("parent directory does not exist: {parent}"),
            ));
        }
        if !is_directory_attrs(&parent).map_err(map_path)? {
            return Err(DaclError::new(
                DaclErrorCode::NotDirectory,
                format!("parent is not a directory: {parent}"),
            ));
        }
        _parent_guard = Some(open_parent_no_delete_guard(&parent)?);

        let mask = expected_access_mask(ObjectClass::File, kind, profile)
            .map_err(|e| DaclError::new(DaclErrorCode::Failed, e))?;
        let mut sd = build_protected_sd(&token, mask)
            .map_err(|e| DaclError::new(DaclErrorCode::Failed, e))?;
        let sa = sd.security_attributes();
        let win32_path = to_extended_win32_path(&full);
        let wide = to_wide(&win32_path);
        let created = unsafe { CreateDirectoryW(PCWSTR(wide.as_ptr()), Some(&sa as *const _)) };
        if let Err(err) = created {
            let win32 = crate::pathutil::hresult_to_win32(err.code().0);
            if win32 == ERROR_ALREADY_EXISTS.0 {
                // Race: fall through to verify existing.
            } else if win32 == ERROR_ACCESS_DENIED.0 {
                return Err(DaclError::new(
                    DaclErrorCode::AccessDenied,
                    format!("CreateDirectoryW access denied (win32={win32})"),
                ));
            } else {
                return Err(DaclError::new(
                    DaclErrorCode::Failed,
                    format!("CreateDirectoryW failed win32={win32} ({err})"),
                ));
            }
        }
        // Keep sd alive through CreateDirectoryW.
        let _ = sa;
        drop(sd);
    }

    // Verify private_rw on resulting directory.
    let win32_path = to_extended_win32_path(&full);
    let handle = open_for_verify(&win32_path, true)?;
    verify_handle_kind_and_final(&handle, &full, kind)?;
    verify_file_protected(handle.as_raw(), kind, profile, &token).map_err(|e| {
        DaclError::new(
            DaclErrorCode::DaclInvalid,
            format!("protected DACL verify failed: {e}"),
        )
    })?;
    Ok(full)
}

/// Two-phase set that converges owner/group/DACL to the target profile under strict verify.
///
/// 1. Prefer full owner/group+DACL via handle (WRITE_DAC|WRITE_OWNER) or path API.
/// 2. If package_rx blocks WRITE_OWNER open, first temporarily set private_rw via named API
///    (owner implicit WRITE_DAC) to regain handle rights, then set the target profile full.
/// 3. Final strict verify; non-TokenUser owner that cannot be fixed fails closed.
pub fn set_protected_path(
    path: &str,
    expected_kind: &str,
    profile: &str,
) -> Result<String, DaclError> {
    let kind = PathKind::parse(expected_kind).ok_or_else(|| {
        DaclError::new(
            DaclErrorCode::InvalidKind,
            format!("expectedKind must be 'file' or 'directory', got {expected_kind}"),
        )
    })?;
    let profile = ProtectedProfile::parse(profile).ok_or_else(|| {
        DaclError::new(
            DaclErrorCode::InvalidProfile,
            format!("profile must be 'private_rw' or 'package_rx', got {profile}"),
        )
    })?;

    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;

    let token =
        CurrentTokenUser::capture().map_err(|e| DaclError::new(DaclErrorCode::Failed, e))?;

    let is_dir = kind == PathKind::Directory;
    let win32_path = to_extended_win32_path(&full);
    // Kind/reparse check via read handle first.
    {
        let handle = open_for_verify(&win32_path, is_dir)?;
        verify_handle_kind_and_final(&handle, &full, kind)?;
    }

    let target_mask = expected_access_mask(ObjectClass::File, kind, profile)
        .map_err(|e| DaclError::new(DaclErrorCode::Failed, e))?;
    let private_mask = expected_access_mask(ObjectClass::File, kind, ProtectedProfile::PrivateRw)
        .map_err(|e| DaclError::new(DaclErrorCode::Failed, e))?;

    // Phase A: try full rights handle set.
    let mut applied = false;
    if let Ok(h) = open_for_set_full(&win32_path, is_dir) {
        crate::security::set_file_protected(h.as_raw(), kind, profile, &token).map_err(|e| {
            DaclError::new(
                DaclErrorCode::Failed,
                format!("SetSecurityInfo full failed: {e}"),
            )
        })?;
        applied = true;
    }

    // Phase B: path-based full set (owner implicit WRITE_DAC / may set owner+group).
    if !applied {
        if let Err(e) = set_protected_on_file_path(&full, &token, target_mask) {
            // Phase C: if target is not private_rw, first restore private_rw to regain WRITE_OWNER,
            // then apply target. Covers package_rx → any profile and foreign-group recovery.
            if profile != ProtectedProfile::PrivateRw {
                set_protected_on_file_path(&full, &token, private_mask).map_err(|e2| {
                    DaclError::new(
                        DaclErrorCode::Failed,
                        format!("phase-C private_rw restore failed: {e2}; prior: {e}"),
                    )
                })?;
                // Now open with full rights and set target, or path-set target.
                if let Ok(h) = open_for_set_full(&win32_path, is_dir) {
                    crate::security::set_file_protected(h.as_raw(), kind, profile, &token)
                        .map_err(|e3| {
                            DaclError::new(
                                DaclErrorCode::Failed,
                                format!("phase-C target set after private_rw failed: {e3}"),
                            )
                        })?;
                } else {
                    set_protected_on_file_path(&full, &token, target_mask).map_err(|e3| {
                        DaclError::new(
                            DaclErrorCode::Failed,
                            format!("phase-C path target set failed: {e3}"),
                        )
                    })?;
                }
            } else {
                // Target is private_rw; try WRITE_DAC-only handle then path again is already failed.
                if let Ok(h) = open_for_set_dacl(&win32_path, is_dir) {
                    crate::security::set_file_protected(h.as_raw(), kind, profile, &token)
                        .map_err(|e2| {
                            DaclError::new(
                                DaclErrorCode::Failed,
                                format!("dacl-only handle set failed: {e2}; path full failed: {e}"),
                            )
                        })?;
                } else {
                    return Err(DaclError::new(
                        DaclErrorCode::Failed,
                        format!("unable to set protected path (full path failed): {e}"),
                    ));
                }
            }
        }
    }

    // Strict final verify. If owner/group still foreign, one more full path set then re-verify.
    let vhandle = open_for_verify(&win32_path, is_dir)?;
    verify_handle_kind_and_final(&vhandle, &full, kind)?;
    if let Err(e) = verify_file_protected(vhandle.as_raw(), kind, profile, &token) {
        // Convergence retry: force full owner/group via named API, then verify again.
        set_protected_on_file_path(&full, &token, target_mask).map_err(|e2| {
            DaclError::new(
                DaclErrorCode::DaclInvalid,
                format!("post-set verify failed: {e}; convergence path set failed: {e2}"),
            )
        })?;
        let v2 = open_for_verify(&win32_path, is_dir)?;
        verify_handle_kind_and_final(&v2, &full, kind)?;
        verify_file_protected(v2.as_raw(), kind, profile, &token).map_err(|e2| {
            // Non-TokenUser owner that cannot be fixed → fail closed (criterion-compatible).
            DaclError::new(
                DaclErrorCode::DaclInvalid,
                format!("post-set protected DACL verify failed after convergence: {e2}"),
            )
        })?;
    }
    Ok(full)
}

pub fn verify_protected_path(
    path: &str,
    expected_kind: &str,
    profile: &str,
) -> Result<String, DaclError> {
    let kind = PathKind::parse(expected_kind).ok_or_else(|| {
        DaclError::new(
            DaclErrorCode::InvalidKind,
            format!("expectedKind must be 'file' or 'directory', got {expected_kind}"),
        )
    })?;
    let profile = ProtectedProfile::parse(profile).ok_or_else(|| {
        DaclError::new(
            DaclErrorCode::InvalidProfile,
            format!("profile must be 'private_rw' or 'package_rx', got {profile}"),
        )
    })?;

    let full = normalize_user_path(path).map_err(map_path)?;
    ensure_local_ntfs(&full).map_err(map_path)?;
    ensure_no_ancestor_reparse(&full).map_err(map_path)?;

    let token =
        CurrentTokenUser::capture().map_err(|e| DaclError::new(DaclErrorCode::Failed, e))?;

    let is_dir = kind == PathKind::Directory;
    let win32_path = to_extended_win32_path(&full);
    let handle = open_for_verify(&win32_path, is_dir)?;
    verify_handle_kind_and_final(&handle, &full, kind)?;
    verify_file_protected(handle.as_raw(), kind, profile, &token).map_err(|e| {
        DaclError::new(
            DaclErrorCode::DaclInvalid,
            format!("protected DACL verify failed: {e}"),
        )
    })?;
    Ok(full)
}

/// Open existing path and verify private_rw directory (for atomic parent gate).
pub fn require_private_rw_directory(path: &str) -> Result<String, DaclError> {
    verify_protected_path(path, "directory", "private_rw")
}

/// Open existing path and verify private_rw file.
pub fn require_private_rw_file(path: &str) -> Result<String, DaclError> {
    verify_protected_path(path, "file", "private_rw")
}

// Silence unused GetLastError warning path if not used in all builds.
#[allow(dead_code)]
fn _last_error() -> u32 {
    unsafe { GetLastError().0 }
}
