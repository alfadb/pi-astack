//! Shared Windows path contract for absolute local NTFS / no-reparse paths.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path};
use std::ptr;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
    HANDLE,
};
use windows::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FileAttributeTagInfo, FileIdInfo, GetDriveTypeW, GetFileAttributesW,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetFullPathNameW,
    GetVolumeInformationW, GetVolumePathNameW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, INVALID_FILE_ATTRIBUTES, OPEN_EXISTING,
    SYNCHRONIZE, VOLUME_NAME_DOS,
};

pub const DRIVE_FIXED: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathErrorCode {
    InvalidPath,
    AncestorReparse,
    Reparse,
    UnsupportedVolume,
    NotDirectory,
    NotFile,
    NotFound,
    AccessDenied,
    IdentityChanged,
}

#[derive(Debug)]
pub struct PathError {
    pub code: PathErrorCode,
    pub detail: String,
}

impl PathError {
    pub fn new(code: PathErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// Private RAII handle. Never converted to a JS number.
pub struct OwnedHandle(pub HANDLE);

impl OwnedHandle {
    pub fn as_raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
            self.0 = HANDLE::default();
        }
    }
}

// napi classes are not Send across threads by default; process-local is fine.
unsafe impl Send for OwnedHandle {}

#[derive(Clone, Debug)]
pub struct FileIdentity {
    pub canonical_path: String,
    pub volume_hex: String,
    pub file_id_hex: String,
}

pub fn resolve_directory_identity(input: &str) -> Result<FileIdentity, PathError> {
    let full = normalize_user_path(input)?;
    ensure_local_ntfs(&full)?;
    ensure_no_ancestor_reparse(&full)?;

    let win32_path = to_extended_win32_path(&full);
    let dir_handle = open_identity_probe(&win32_path)?;
    let tag = query_attribute_tag(dir_handle.as_raw()).map_err(|e| {
        PathError::new(
            PathErrorCode::AccessDenied,
            format!("attribute query failed: {e}"),
        )
    })?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(PathError::new(
            PathErrorCode::Reparse,
            "leaf reparse points / symlinks / junctions are rejected",
        ));
    }
    if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
        return Err(PathError::new(
            PathErrorCode::NotDirectory,
            "target is not a directory",
        ));
    }

    let final_path = get_final_path_name(dir_handle.as_raw())?;
    if !paths_equal_win(&final_path, &full) {
        return Err(PathError::new(
            PathErrorCode::IdentityChanged,
            format!(
        "GetFinalPathNameByHandleW diverged from canonical input (input={full}; final={final_path})"
      ),
        ));
    }

    let info = query_file_id_info(dir_handle.as_raw()).map_err(|e| {
        PathError::new(
            PathErrorCode::AccessDenied,
            format!("file id query failed: {e}"),
        )
    })?;
    drop(dir_handle);

    Ok(FileIdentity {
        canonical_path: full,
        volume_hex: info.volume_hex,
        file_id_hex: info.file_id_hex,
    })
}

pub fn resolve_file_identity(input: &str) -> Result<FileIdentity, PathError> {
    let full = normalize_user_path(input)?;
    ensure_local_ntfs(&full)?;
    ensure_no_ancestor_reparse(&full)?;

    let win32_path = to_extended_win32_path(&full);
    let handle = open_identity_probe(&win32_path)?;
    let tag = query_attribute_tag(handle.as_raw()).map_err(|e| {
        PathError::new(
            PathErrorCode::AccessDenied,
            format!("attribute query failed: {e}"),
        )
    })?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(PathError::new(
            PathErrorCode::Reparse,
            "leaf reparse points / symlinks / junctions are rejected",
        ));
    }
    if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
        return Err(PathError::new(
            PathErrorCode::NotFile,
            "target is a directory, expected file",
        ));
    }

    let final_path = get_final_path_name(handle.as_raw())?;
    if !paths_equal_win(&final_path, &full) {
        return Err(PathError::new(
            PathErrorCode::IdentityChanged,
            format!(
        "GetFinalPathNameByHandleW diverged from canonical input (input={full}; final={final_path})"
      ),
        ));
    }

    let info = query_file_id_info(handle.as_raw()).map_err(|e| {
        PathError::new(
            PathErrorCode::AccessDenied,
            format!("file id query failed: {e}"),
        )
    })?;
    drop(handle);

    Ok(FileIdentity {
        canonical_path: full,
        volume_hex: info.volume_hex,
        file_id_hex: info.file_id_hex,
    })
}

/// Validate + GetFullPathName + short-name reject + absolute local shape.
pub fn normalize_user_path(input: &str) -> Result<String, PathError> {
    validate_input_path(input)?;
    let full = get_full_path_name(input)?;
    validate_absolute_local_path(&full)?;
    reject_short_name_components(&full)?;
    Ok(full)
}

pub fn parent_path(full: &str) -> Result<String, PathError> {
    let p = Path::new(full);
    let parent = p.parent().ok_or_else(|| {
        PathError::new(PathErrorCode::InvalidPath, "path has no parent directory")
    })?;
    let s = parent.to_string_lossy().to_string();
    if s.is_empty() {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            "path has empty parent directory",
        ));
    }
    Ok(normalize_trailing(s))
}

pub fn validate_input_path(input: &str) -> Result<(), PathError> {
    if input.is_empty() || input.contains('\0') {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            "path must be non-empty and contain no NUL",
        ));
    }
    let bytes = input.as_bytes();
    if bytes.first().is_some_and(|b| b.is_ascii_whitespace())
        || bytes.last().is_some_and(|b| b.is_ascii_whitespace())
    {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            "leading/trailing whitespace in path is rejected",
        ));
    }
    if has_verbatim_or_device_prefix(input) {
        return Err(PathError::new(
      PathErrorCode::InvalidPath,
      "verbatim/device prefixes (\\\\?\\ / \\\\.\\) are rejected; use ordinary drive-absolute paths",
    ));
    }
    if is_unc_like(input) {
        return Err(PathError::new(
            PathErrorCode::UnsupportedVolume,
            "UNC / remote paths are rejected",
        ));
    }
    if !is_plain_drive_absolute(input) {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            "path must be ordinary drive-absolute (e.g. C:\\...)",
        ));
    }
    if let Some(dev) = find_dos_device_component(input) {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            format!("DOS device name '{dev}' is rejected"),
        ));
    }
    Ok(())
}

fn has_verbatim_or_device_prefix(path: &str) -> bool {
    let p = path.as_bytes();
    if p.len() >= 4 {
        let a = p[0];
        let b = p[1];
        let c = p[2];
        let d = p[3];
        let slash = |x: u8| x == b'\\' || x == b'/';
        if slash(a) && slash(b) && (c == b'?' || c == b'.') && slash(d) {
            return true;
        }
    }
    false
}

fn is_plain_drive_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

fn is_unc_like(path: &str) -> bool {
    let b = path.as_bytes();
    if b.len() >= 2 && ((b[0] == b'\\' && b[1] == b'\\') || (b[0] == b'/' && b[1] == b'/')) {
        if has_verbatim_or_device_prefix(path) {
            let upper = path.to_ascii_uppercase();
            return upper.contains(r"\UNC\") || upper.contains("/UNC/");
        }
        return true;
    }
    false
}

const DOS_DEVICES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn find_dos_device_component(path: &str) -> Option<String> {
    for comp in Path::new(path).components() {
        let Component::Normal(os) = comp else {
            continue;
        };
        let s = os.to_string_lossy();
        let base = s.split('.').next().unwrap_or(&s);
        let upper = base.to_ascii_uppercase();
        if DOS_DEVICES.iter().any(|d| *d == upper) {
            return Some(upper);
        }
    }
    None
}

fn reject_short_name_components(full: &str) -> Result<(), PathError> {
    for comp in Path::new(full).components() {
        let Component::Normal(os) = comp else {
            continue;
        };
        let s = os.to_string_lossy();
        if s.chars().any(|c| c == '~') {
            let bytes = s.as_bytes();
            if let Some(pos) = bytes.iter().position(|&c| c == b'~') {
                let after = &s[pos + 1..];
                let digits = after.chars().take_while(|c| c.is_ascii_digit()).count();
                if digits > 0 {
                    return Err(PathError::new(
                        PathErrorCode::InvalidPath,
                        format!("8.3 short-name path component rejected: {s}"),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_absolute_local_path(full: &str) -> Result<(), PathError> {
    if has_verbatim_or_device_prefix(full) {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            "normalized path unexpectedly contains verbatim/device prefix",
        ));
    }
    if is_unc_like(full) {
        return Err(PathError::new(
            PathErrorCode::UnsupportedVolume,
            "UNC / remote paths are rejected",
        ));
    }
    if !is_plain_drive_absolute(full) {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            format!("path is not a local drive-absolute path: {full}"),
        ));
    }
    if let Some(dev) = find_dos_device_component(full) {
        return Err(PathError::new(
            PathErrorCode::InvalidPath,
            format!("DOS device name '{dev}' is rejected"),
        ));
    }
    Ok(())
}

pub fn to_extended_win32_path(ordinary_dos: &str) -> String {
    let norm = normalize_trailing(ordinary_dos.replace('/', "\\"));
    if norm.starts_with(r"\\?\") || norm.starts_with(r"\\.\") {
        return norm;
    }
    format!(r"\\?\{norm}")
}

pub fn ensure_local_ntfs(full: &str) -> Result<(), PathError> {
    let wide = to_wide(full);
    let mut vol_buf = vec![0u16; 64];
    let mut ok = unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), &mut vol_buf) };
    if ok.is_err() {
        vol_buf.resize(32_768, 0);
        ok = unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), &mut vol_buf) };
    }
    if ok.is_err() {
        let err = unsafe { GetLastError() };
        return Err(PathError::new(
            PathErrorCode::UnsupportedVolume,
            format!("GetVolumePathNameW failed win32={}", err.0),
        ));
    }
    let vol_path = wides_to_string(&vol_buf);
    if vol_path.is_empty() {
        return Err(PathError::new(
            PathErrorCode::UnsupportedVolume,
            "GetVolumePathNameW returned empty",
        ));
    }
    let vol_wide = to_wide(&vol_path);
    let drive_type = unsafe { GetDriveTypeW(PCWSTR(vol_wide.as_ptr())) };
    if drive_type != DRIVE_FIXED {
        return Err(PathError::new(
            PathErrorCode::UnsupportedVolume,
            format!("drive type {drive_type} is not DRIVE_FIXED (local disk)"),
        ));
    }

    let mut fs_name = vec![0u16; 64];
    let mut serial: u32 = 0;
    let mut max_comp: u32 = 0;
    let mut flags: u32 = 0;
    unsafe {
        GetVolumeInformationW(
            PCWSTR(vol_wide.as_ptr()),
            None,
            Some(&mut serial),
            Some(&mut max_comp),
            Some(&mut flags),
            Some(&mut fs_name),
        )
        .map_err(|e| {
            PathError::new(
                PathErrorCode::UnsupportedVolume,
                format!("GetVolumeInformationW failed: {e}"),
            )
        })?;
    }
    let fs = wides_to_string(&fs_name);
    if !fs.eq_ignore_ascii_case("NTFS") {
        return Err(PathError::new(
            PathErrorCode::UnsupportedVolume,
            format!("filesystem '{fs}' is not NTFS"),
        ));
    }
    Ok(())
}

pub fn ensure_no_ancestor_reparse(full: &str) -> Result<(), PathError> {
    let path = Path::new(full);
    let mut built = String::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => {
                built.push_str(&p.as_os_str().to_string_lossy());
                continue;
            }
            Component::RootDir => {
                if !built.ends_with('\\') && !built.ends_with('/') {
                    built.push('\\');
                }
                continue;
            }
            Component::Normal(os) => {
                if !built.ends_with('\\') && !built.ends_with('/') && !built.is_empty() {
                    built.push('\\');
                }
                built.push_str(&os.to_string_lossy());
            }
            Component::CurDir | Component::ParentDir => {
                return Err(PathError::new(
                    PathErrorCode::InvalidPath,
                    "unresolved . or .. component after GetFullPathNameW",
                ));
            }
        }
        if paths_equal_win(&built, full) {
            break;
        }
        let attr_path = to_extended_win32_path(&built);
        let attrs = unsafe { GetFileAttributesW(PCWSTR(to_wide(&attr_path).as_ptr())) };
        if attrs == INVALID_FILE_ATTRIBUTES {
            let err = unsafe { GetLastError() };
            if err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND {
                return Err(PathError::new(
                    PathErrorCode::NotFound,
                    format!("ancestor path not found: {built}"),
                ));
            }
            if err == ERROR_ACCESS_DENIED {
                return Err(PathError::new(
                    PathErrorCode::AccessDenied,
                    format!("ancestor path access denied: {built}"),
                ));
            }
            return Err(PathError::new(
                PathErrorCode::AccessDenied,
                format!(
                    "GetFileAttributesW failed for ancestor {built} win32={}",
                    err.0
                ),
            ));
        }
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(PathError::new(
                PathErrorCode::AncestorReparse,
                format!("ancestor reparse point rejected: {built}"),
            ));
        }
    }
    Ok(())
}

pub fn path_exists_no_reparse_leaf(full: &str) -> Result<bool, PathError> {
    let attr_path = to_extended_win32_path(full);
    let attrs = unsafe { GetFileAttributesW(PCWSTR(to_wide(&attr_path).as_ptr())) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        let err = unsafe { GetLastError() };
        if err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND {
            return Ok(false);
        }
        if err == ERROR_ACCESS_DENIED {
            return Err(PathError::new(
                PathErrorCode::AccessDenied,
                format!("GetFileAttributesW access denied: {full}"),
            ));
        }
        return Err(PathError::new(
            PathErrorCode::AccessDenied,
            format!("GetFileAttributesW failed win32={}", err.0),
        ));
    }
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(PathError::new(
            PathErrorCode::Reparse,
            "leaf reparse point rejected",
        ));
    }
    Ok(true)
}

pub fn is_directory_attrs(full: &str) -> Result<bool, PathError> {
    let attr_path = to_extended_win32_path(full);
    let attrs = unsafe { GetFileAttributesW(PCWSTR(to_wide(&attr_path).as_ptr())) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        let err = unsafe { GetLastError() };
        if err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND {
            return Err(PathError::new(PathErrorCode::NotFound, "path not found"));
        }
        return Err(PathError::new(
            PathErrorCode::AccessDenied,
            format!("GetFileAttributesW failed win32={}", err.0),
        ));
    }
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(PathError::new(
            PathErrorCode::Reparse,
            "leaf reparse point rejected",
        ));
    }
    Ok(attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0)
}

fn open_identity_probe(win32_path: &str) -> Result<OwnedHandle, PathError> {
    let wide = to_wide(win32_path);
    let access = FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0;
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    let flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
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
        Ok(_) => Err(PathError::new(
            PathErrorCode::AccessDenied,
            "CreateFileW returned INVALID_HANDLE_VALUE",
        )),
        Err(err) => {
            let win32 = hresult_to_win32(err.code().0);
            if win32 == ERROR_FILE_NOT_FOUND.0 || win32 == ERROR_PATH_NOT_FOUND.0 {
                return Err(PathError::new(
                    PathErrorCode::NotFound,
                    format!("path does not exist (win32={win32})"),
                ));
            }
            if win32 == ERROR_ACCESS_DENIED.0 {
                return Err(PathError::new(
                    PathErrorCode::AccessDenied,
                    format!("CreateFileW access denied (win32={win32})"),
                ));
            }
            if win32 == 267 {
                return Err(PathError::new(
                    PathErrorCode::NotDirectory,
                    format!("target is not a directory (win32={win32})"),
                ));
            }
            Err(PathError::new(
                PathErrorCode::AccessDenied,
                format!("CreateFileW failed win32={win32} ({err})"),
            ))
        }
    }
}

pub struct FileIdSnapshot {
    pub volume_hex: String,
    pub file_id_hex: String,
}

pub fn query_attribute_tag(handle: HANDLE) -> Result<FILE_ATTRIBUTE_TAG_INFO, String> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO {
        FileAttributes: 0,
        ReparseTag: 0,
    };
    unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
        .map_err(|e| {
            format!(
                "GetFileInformationByHandleEx(FileAttributeTagInfo) win32={}",
                e.code().0
            )
        })?;
    }
    Ok(info)
}

pub fn query_file_id_info(handle: HANDLE) -> Result<FileIdSnapshot, String> {
    let mut info = FILE_ID_INFO {
        VolumeSerialNumber: 0,
        FileId: Default::default(),
    };
    unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
        .map_err(|e| {
            format!(
                "GetFileInformationByHandleEx(FileIdInfo) win32={}",
                e.code().0
            )
        })?;
    }
    let bytes = info.FileId.Identifier;
    let mut hex = String::with_capacity(32);
    for b in bytes {
        hex.push_str(&format!("{b:02x}"));
    }
    Ok(FileIdSnapshot {
        volume_hex: format!("{:016x}", info.VolumeSerialNumber),
        file_id_hex: hex,
    })
}

fn get_full_path_name(input: &str) -> Result<String, PathError> {
    let wide = to_wide(input);
    let mut buf = vec![0u16; 512];
    loop {
        let n = unsafe { GetFullPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buf), None) };
        if n == 0 {
            let err = unsafe { GetLastError() };
            return Err(PathError::new(
                PathErrorCode::InvalidPath,
                format!("GetFullPathNameW failed win32={}", err.0),
            ));
        }
        if (n as usize) < buf.len() {
            buf.truncate(n as usize);
            let s = String::from_utf16_lossy(&buf);
            return Ok(normalize_trailing(s));
        }
        buf.resize(n as usize + 2, 0);
    }
}

pub fn get_final_path_name(handle: HANDLE) -> Result<String, PathError> {
    let mut buf = vec![0u16; 512];
    loop {
        let n = unsafe { GetFinalPathNameByHandleW(handle, &mut buf, VOLUME_NAME_DOS) };
        if n == 0 {
            let err = unsafe { GetLastError() };
            return Err(PathError::new(
                PathErrorCode::IdentityChanged,
                format!("GetFinalPathNameByHandleW failed win32={}", err.0),
            ));
        }
        if (n as usize) < buf.len() {
            buf.truncate(n as usize);
            let s = String::from_utf16_lossy(&buf);
            return Ok(normalize_trailing(strip_extended_prefix(&s).to_string()));
        }
        buf.resize(n as usize + 2, 0);
    }
}

fn strip_extended_prefix(path: &str) -> &str {
    let upper = path.as_bytes();
    if upper.len() >= 4
        && upper[0] == b'\\'
        && upper[1] == b'\\'
        && (upper[2] == b'?' || upper[2] == b'.')
        && upper[3] == b'\\'
    {
        let rest = &path[4..];
        if rest.len() >= 4 && rest.as_bytes()[..4].eq_ignore_ascii_case(b"UNC\\") {
            return path;
        }
        return rest;
    }
    path
}

pub fn normalize_trailing(mut s: String) -> String {
    s = s.replace('/', "\\");
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s
}

pub fn paths_equal_win(a: &str, b: &str) -> bool {
    let na = normalize_trailing(strip_extended_prefix(a).to_string());
    let nb = normalize_trailing(strip_extended_prefix(b).to_string());
    let wa = to_wide_no_nul(&na);
    let wb = to_wide_no_nul(&nb);
    let r = unsafe { CompareStringOrdinal(&wa, &wb, true) };
    r == CSTR_EQUAL
}

pub fn to_wide(path: &str) -> Vec<u16> {
    OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn to_wide_no_nul(path: &str) -> Vec<u16> {
    OsStr::new(path).encode_wide().collect()
}

fn wides_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

pub fn hresult_to_win32(hr: i32) -> u32 {
    let hr_u = hr as u32;
    if (hr_u & 0xFFFF_0000) == 0x8007_0000 {
        hr_u & 0xFFFF
    } else if hr_u == 0 {
        0
    } else {
        hr_u
    }
}
