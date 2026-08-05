//! protected_dacl_v1 primitives: current-primary-TokenUser owner/group + exact protected DACL.
//!
//! Threat boundary (contract):
//! - Object owner can always rewrite DACL (implicit WRITE_DAC); this is not a defense against the owner.
//! - Same-token malicious processes are outside the contract.
//! - Goal is fail-closed verification of expected private/package profiles against foreign/weak/inherited ACLs.
//! - Append/retained Global named mutex names remain DoS-able under same-machine squat (fail-closed
//!   availability residual). Same-token malice remains out of contract.

use std::mem;
use std::ptr;
use windows::core::BOOL;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE, HLOCAL,
};
use windows::Win32::Security::Authorization::{
    GetSecurityInfo, SetNamedSecurityInfoW, SetSecurityInfo, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
    SE_OBJECT_TYPE,
};
use windows::Win32::Security::{
    AclSizeInformation, AddAccessAllowedAceEx, CopySid, EqualSid, GetAce, GetAclInformation,
    GetLengthSid, GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
    InitializeAcl, InitializeSecurityDescriptor, IsValidSid, MakeSelfRelativeSD,
    SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorGroup,
    SetSecurityDescriptorOwner, TokenUser, ACCESS_ALLOWED_ACE, ACE_FLAGS, ACE_HEADER, ACL,
    ACL_REVISION, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR_CONTROL, SE_DACL_DEFAULTED,
    SE_DACL_PRESENT, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    FILE_ALL_ACCESS, FILE_EXECUTE, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
    FILE_READ_EA, FILE_TRAVERSE, READ_CONTROL, SYNCHRONIZE,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken, MUTEX_ALL_ACCESS};

/// SECURITY_DESCRIPTOR_REVISION (winnt.h) — avoid pulling SystemServices feature.
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
/// ACCESS_ALLOWED_ACE_TYPE
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// INHERITED_ACE flag bit on ACE header.
const INHERITED_ACE_FLAG: u8 = 0x10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectedProfile {
    PrivateRw,
    PackageRx,
}

impl ProtectedProfile {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "private_rw" => Some(Self::PrivateRw),
            "package_rx" => Some(Self::PackageRx),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    File,
    Directory,
}

impl PathKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "file" => Some(Self::File),
            "directory" => Some(Self::Directory),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectClass {
    File,
    KernelMutex,
}

/// Exact access mask for (class, kind, profile).
/// KernelMutex + package_rx is not a valid combination — fail closed (no silent all-access map).
pub fn expected_access_mask(
    class: ObjectClass,
    kind: PathKind,
    profile: ProtectedProfile,
) -> Result<u32, String> {
    match (class, profile, kind) {
    (ObjectClass::KernelMutex, ProtectedProfile::PrivateRw, _) => Ok(MUTEX_ALL_ACCESS.0),
    (ObjectClass::KernelMutex, ProtectedProfile::PackageRx, _) => Err(
      "KernelMutex does not support package_rx profile (unreachable; refuse silent MUTEX_ALL_ACCESS mapping)"
        .into(),
    ),
    (ObjectClass::File, ProtectedProfile::PrivateRw, _) => Ok(FILE_ALL_ACCESS.0),
    // package_rx: current user traverse/read for dirs; read/execute for files; no write/delete.
    (ObjectClass::File, ProtectedProfile::PackageRx, PathKind::Directory) => Ok(
      READ_CONTROL.0
        | SYNCHRONIZE.0
        | FILE_LIST_DIRECTORY.0
        | FILE_READ_ATTRIBUTES.0
        | FILE_READ_EA.0
        | FILE_TRAVERSE.0,
    ),
    (ObjectClass::File, ProtectedProfile::PackageRx, PathKind::File) => Ok(
      READ_CONTROL.0
        | SYNCHRONIZE.0
        | FILE_READ_DATA.0
        | FILE_READ_ATTRIBUTES.0
        | FILE_READ_EA.0
        | FILE_EXECUTE.0,
    ),
  }
}

/// DWORD-aligned byte buffer for ACL / self-relative SECURITY_DESCRIPTOR material.
/// Windows SD/ACL APIs require pointer alignment; raw Vec<u8> is not guaranteed.
struct AlignedBytes {
    words: Vec<u32>,
    len_bytes: usize,
}

impl AlignedBytes {
    fn zeros(len_bytes: usize) -> Self {
        let words = len_bytes.div_ceil(4);
        Self {
            words: vec![0u32; words],
            len_bytes,
        }
    }

    fn as_mut_ptr(&mut self) -> *mut u8 {
        self.words.as_mut_ptr() as *mut u8
    }

    fn as_ptr(&self) -> *const u8 {
        self.words.as_ptr() as *const u8
    }
}

/// Owned copy of the current primary TokenUser SID + short non-reversible hash tag.
pub struct CurrentTokenUser {
    sid_bytes: Vec<u8>,
    /// 8 lowercase hex chars (FNV-1a 32-bit of SID bytes). Does not expose the SID.
    pub sid_hash8: String,
}

impl CurrentTokenUser {
    pub fn capture() -> Result<Self, String> {
        let mut token = HANDLE::default();
        unsafe {
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(|e| format!("OpenProcessToken failed: {e}"))?;
        }
        let _token_guard = HandleGuard(token);

        let mut needed: u32 = 0;
        let first = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut needed) };
        // Expect ERROR_INSUFFICIENT_BUFFER
        if first.is_ok() {
            return Err(
                "GetTokenInformation(TokenUser) unexpectedly succeeded with zero buffer".into(),
            );
        }
        let err = unsafe { GetLastError() };
        if err != ERROR_INSUFFICIENT_BUFFER && needed == 0 {
            return Err(format!(
                "GetTokenInformation(TokenUser) size query failed win32={}",
                err.0
            ));
        }
        if needed < mem::size_of::<TOKEN_USER>() as u32 {
            return Err(format!("TokenUser buffer too small: {needed}"));
        }
        // Align TokenUser buffer too.
        let mut buf = AlignedBytes::zeros(needed as usize);
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut _),
                needed,
                &mut needed,
            )
            .map_err(|e| format!("GetTokenInformation(TokenUser) failed: {e}"))?;
        }
        let token_user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
        let sid = token_user.User.Sid;
        if sid.0.is_null() || !unsafe { IsValidSid(sid) }.as_bool() {
            return Err("TokenUser SID is invalid".into());
        }
        let sid_len = unsafe { GetLengthSid(sid) };
        if sid_len == 0 || sid_len > 1024 {
            return Err(format!("GetLengthSid out of range: {sid_len}"));
        }
        let mut sid_bytes = vec![0u8; sid_len as usize];
        unsafe {
            CopySid(sid_len, PSID(sid_bytes.as_mut_ptr() as *mut _), sid)
                .map_err(|e| format!("CopySid failed: {e}"))?;
        }
        let sid_hash8 = format!("{:08x}", fnv1a32(&sid_bytes));
        Ok(Self {
            sid_bytes,
            sid_hash8,
        })
    }

    pub fn psid(&self) -> PSID {
        PSID(self.sid_bytes.as_ptr() as *mut _)
    }

    pub fn sid_bytes(&self) -> &[u8] {
        &self.sid_bytes
    }
}

struct HandleGuard(HANDLE);
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn fnv1a32(data: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in data {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Owned absolute SD materials + self-relative blob suitable for SECURITY_ATTRIBUTES.
pub struct OwnedSecurityDescriptor {
    /// Keeps SID / ACL / absolute SD buffers alive.
    _sid: Vec<u8>,
    _acl: AlignedBytes,
    _absolute: Box<SECURITY_DESCRIPTOR>,
    /// Self-relative SD bytes (DWORD-aligned; pointed by SECURITY_ATTRIBUTES).
    relative: AlignedBytes,
}

impl OwnedSecurityDescriptor {
    pub fn security_attributes(&mut self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.relative.as_mut_ptr() as *mut _,
            bInheritHandle: false.into(),
        }
    }
}

/// Build owner=group=TokenUser, DACL present/non-defaulted/protected, exact one ACCESS_ALLOWED ACE.
pub fn build_protected_sd(
    token: &CurrentTokenUser,
    access_mask: u32,
) -> Result<OwnedSecurityDescriptor, String> {
    let sid_len = token.sid_bytes().len() as u32;
    // ACCESS_ALLOWED_ACE is Header+Mask+SidStart(u32); SID replaces SidStart onward.
    let ace_size = (mem::size_of::<ACE_HEADER>() + mem::size_of::<u32>() + sid_len as usize) as u32;
    let acl_size = mem::size_of::<ACL>() as u32 + ace_size;
    let mut acl = AlignedBytes::zeros(acl_size as usize);
    let acl_ptr = acl.as_mut_ptr() as *mut ACL;
    unsafe {
        InitializeAcl(acl_ptr, acl_size, ACL_REVISION)
            .map_err(|e| format!("InitializeAcl failed: {e}"))?;
        AddAccessAllowedAceEx(
            acl_ptr,
            ACL_REVISION,
            ACE_FLAGS(0), // no inherit / no inherited flags
            access_mask,
            token.psid(),
        )
        .map_err(|e| format!("AddAccessAllowedAceEx failed: {e}"))?;
    }

    let mut sid = token.sid_bytes().to_vec();
    let mut absolute = Box::new(SECURITY_DESCRIPTOR::default());
    unsafe {
        InitializeSecurityDescriptor(
            PSECURITY_DESCRIPTOR(&mut *absolute as *mut _ as *mut _),
            SECURITY_DESCRIPTOR_REVISION,
        )
        .map_err(|e| format!("InitializeSecurityDescriptor failed: {e}"))?;
        SetSecurityDescriptorOwner(
            PSECURITY_DESCRIPTOR(&mut *absolute as *mut _ as *mut _),
            Some(PSID(sid.as_mut_ptr() as *mut _)),
            false,
        )
        .map_err(|e| format!("SetSecurityDescriptorOwner failed: {e}"))?;
        SetSecurityDescriptorGroup(
            PSECURITY_DESCRIPTOR(&mut *absolute as *mut _ as *mut _),
            Some(PSID(sid.as_mut_ptr() as *mut _)),
            false,
        )
        .map_err(|e| format!("SetSecurityDescriptorGroup failed: {e}"))?;
        SetSecurityDescriptorDacl(
            PSECURITY_DESCRIPTOR(&mut *absolute as *mut _ as *mut _),
            true,
            Some(acl_ptr),
            false,
        )
        .map_err(|e| format!("SetSecurityDescriptorDacl failed: {e}"))?;
        SetSecurityDescriptorControl(
            PSECURITY_DESCRIPTOR(&mut *absolute as *mut _ as *mut _),
            SE_DACL_PROTECTED,
            SE_DACL_PROTECTED,
        )
        .map_err(|e| format!("SetSecurityDescriptorControl(SE_DACL_PROTECTED) failed: {e}"))?;
    }

    // Absolute → self-relative
    let mut rel_len: u32 = 0;
    let first = unsafe {
        MakeSelfRelativeSD(
            PSECURITY_DESCRIPTOR(&mut *absolute as *mut _ as *mut _),
            None,
            &mut rel_len,
        )
    };
    if first.is_ok() {
        return Err("MakeSelfRelativeSD unexpectedly succeeded with no buffer".into());
    }
    if rel_len == 0 {
        let err = unsafe { GetLastError() };
        return Err(format!(
            "MakeSelfRelativeSD size query failed win32={}",
            err.0
        ));
    }
    let mut relative = AlignedBytes::zeros(rel_len as usize);
    unsafe {
        MakeSelfRelativeSD(
            PSECURITY_DESCRIPTOR(&mut *absolute as *mut _ as *mut _),
            Some(PSECURITY_DESCRIPTOR(relative.as_mut_ptr() as *mut _)),
            &mut rel_len,
        )
        .map_err(|e| format!("MakeSelfRelativeSD failed: {e}"))?;
    }
    // Keep reported length in case API adjusted.
    relative.len_bytes = rel_len as usize;

    Ok(OwnedSecurityDescriptor {
        _sid: sid,
        _acl: acl,
        _absolute: absolute,
        relative,
    })
}

fn build_acl_buf(
    token: &CurrentTokenUser,
    access_mask: u32,
) -> Result<(AlignedBytes, *mut ACL), String> {
    let sid_len = token.sid_bytes().len() as u32;
    let ace_size = (mem::size_of::<ACE_HEADER>() + mem::size_of::<u32>() + sid_len as usize) as u32;
    let acl_size = mem::size_of::<ACL>() as u32 + ace_size;
    let mut acl = AlignedBytes::zeros(acl_size as usize);
    let acl_ptr = acl.as_mut_ptr() as *mut ACL;
    unsafe {
        InitializeAcl(acl_ptr, acl_size, ACL_REVISION)
            .map_err(|e| format!("InitializeAcl failed: {e}"))?;
        AddAccessAllowedAceEx(
            acl_ptr,
            ACL_REVISION,
            ACE_FLAGS(0),
            access_mask,
            token.psid(),
        )
        .map_err(|e| format!("AddAccessAllowedAceEx failed: {e}"))?;
    }
    Ok((acl, acl_ptr))
}

/// Apply protected owner/group + DACL on an open handle.
/// Always attempts full owner/group/DACL first so foreign group cannot stick after dacl-only.
pub fn set_protected_on_handle(
    handle: HANDLE,
    object_type: SE_OBJECT_TYPE,
    token: &CurrentTokenUser,
    access_mask: u32,
) -> Result<(), String> {
    let mut sid = token.sid_bytes().to_vec();
    let (acl_buf, acl_ptr) = build_acl_buf(token, access_mask)?;
    let full = OWNER_SECURITY_INFORMATION
        | GROUP_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION;
    let err_full = unsafe {
        SetSecurityInfo(
            handle,
            object_type,
            full,
            Some(PSID(sid.as_mut_ptr() as *mut _)),
            Some(PSID(sid.as_mut_ptr() as *mut _)),
            Some(acl_ptr),
            None,
        )
    };
    if err_full.0 == 0 {
        drop(acl_buf);
        drop(sid);
        return Ok(());
    }
    // Fallback dacl-only (WRITE_DAC without WRITE_OWNER). Caller must re-verify;
    // if owner/group still foreign, path-based full set is required.
    let dacl_only = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    let err_dacl = unsafe {
        SetSecurityInfo(
            handle,
            object_type,
            dacl_only,
            None,
            None,
            Some(acl_ptr),
            None,
        )
    };
    if err_dacl.0 != 0 {
        return Err(format!(
            "SetSecurityInfo failed win32={} (full) / win32={} (dacl-only)",
            err_full.0, err_dacl.0
        ));
    }
    drop(acl_buf);
    drop(sid);
    Ok(())
}

/// Path-based set for file objects. Prefer this when handle open with WRITE_DAC may be denied
/// by a package_rx DACL — SetNamedSecurityInfoW uses owner implicit WRITE_DAC.
///
/// Always attempts full owner/group/DACL first so dacl-only success cannot leave foreign group.
/// `ordinary_dos_path` must be ordinary drive-absolute (no `\\?\` prefix); advapi named
/// security APIs are more reliable on that form.
pub fn set_protected_on_file_path(
    ordinary_dos_path: &str,
    token: &CurrentTokenUser,
    access_mask: u32,
) -> Result<(), String> {
    let mut sid = token.sid_bytes().to_vec();
    let (acl_buf, acl_ptr) = build_acl_buf(token, access_mask)?;
    // Strip accidental extended prefix if present (ordinary DOS is the common input).
    let path = ordinary_dos_path
        .strip_prefix("\\\\?\\")
        .or_else(|| ordinary_dos_path.strip_prefix("\\\\.\\"))
        .unwrap_or(ordinary_dos_path);
    let wide: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let full = OWNER_SECURITY_INFORMATION
        | GROUP_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION;
    let err_full = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            full,
            Some(PSID(sid.as_mut_ptr() as *mut _)),
            Some(PSID(sid.as_mut_ptr() as *mut _)),
            Some(acl_ptr),
            None,
        )
    };
    if err_full.0 == 0 {
        drop(acl_buf);
        drop(sid);
        return Ok(());
    }
    let dacl_only = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    let err_dacl = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            dacl_only,
            None,
            None,
            Some(acl_ptr),
            None,
        )
    };
    if err_dacl.0 != 0 {
        return Err(format!(
            "SetNamedSecurityInfoW failed win32={} (full) / win32={} (dacl-only) path={path}",
            err_full.0, err_dacl.0
        ));
    }
    drop(acl_buf);
    drop(sid);
    Ok(())
}

/// Strict handle-level verify: owner/group/DACL exact match for expected mask.
pub fn verify_protected_on_handle(
    handle: HANDLE,
    object_type: SE_OBJECT_TYPE,
    token: &CurrentTokenUser,
    access_mask: u32,
) -> Result<(), String> {
    let mut owner: PSID = PSID(ptr::null_mut());
    let mut group: PSID = PSID(ptr::null_mut());
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = PSECURITY_DESCRIPTOR(ptr::null_mut());
    let info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let err = unsafe {
        GetSecurityInfo(
            handle,
            object_type,
            info,
            Some(&mut owner),
            Some(&mut group),
            Some(&mut dacl),
            None,
            Some(&mut sd),
        )
    };
    if err.0 != 0 {
        return Err(format!("GetSecurityInfo failed win32={}", err.0));
    }
    let _free = LocalFreeGuard(sd);

    if owner.0.is_null() || !unsafe { IsValidSid(owner) }.as_bool() {
        return Err("owner SID missing/invalid".into());
    }
    if group.0.is_null() || !unsafe { IsValidSid(group) }.as_bool() {
        return Err("group SID missing/invalid".into());
    }
    // EqualSid returns Result in windows-rs: Ok means equal, Err means not equal / failure.
    if unsafe { EqualSid(owner, token.psid()) }.is_err() {
        return Err("owner SID is not current TokenUser".into());
    }
    if unsafe { EqualSid(group, token.psid()) }.is_err() {
        return Err("group SID is not current TokenUser".into());
    }

    // windows-rs exposes the control out-param as *mut u16; wrap as SECURITY_DESCRIPTOR_CONTROL.
    let mut control_bits: u16 = 0;
    let mut revision: u32 = 0;
    unsafe {
        GetSecurityDescriptorControl(sd, &mut control_bits, &mut revision)
            .map_err(|e| format!("GetSecurityDescriptorControl failed: {e}"))?;
    }
    let control = SECURITY_DESCRIPTOR_CONTROL(control_bits);
    if !control.contains(SE_DACL_PRESENT) {
        return Err("SE_DACL_PRESENT not set".into());
    }
    if control.contains(SE_DACL_DEFAULTED) {
        return Err("SE_DACL_DEFAULTED is set (defaulted DACL rejected)".into());
    }
    if !control.contains(SE_DACL_PROTECTED) {
        return Err("SE_DACL_PROTECTED not set".into());
    }

    let mut dacl_present = BOOL(0);
    let mut dacl_defaulted = BOOL(0);
    let mut dacl_ptr: *mut ACL = ptr::null_mut();
    unsafe {
        GetSecurityDescriptorDacl(sd, &mut dacl_present, &mut dacl_ptr, &mut dacl_defaulted)
            .map_err(|e| format!("GetSecurityDescriptorDacl failed: {e}"))?;
    }
    if !dacl_present.as_bool() {
        return Err("DACL not present".into());
    }
    if dacl_defaulted.as_bool() {
        return Err("DACL is defaulted".into());
    }
    if dacl_ptr.is_null() {
        return Err("DACL pointer is null".into());
    }

    let mut size_info = ACL_SIZE_INFORMATION {
        AceCount: 0,
        AclBytesInUse: 0,
        AclBytesFree: 0,
    };
    unsafe {
        GetAclInformation(
            dacl_ptr,
            &mut size_info as *mut _ as *mut _,
            mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
        .map_err(|e| format!("GetAclInformation failed: {e}"))?;
    }
    if size_info.AceCount != 1 {
        return Err(format!(
            "DACL must contain exactly one ACE, found {}",
            size_info.AceCount
        ));
    }

    let mut ace_ptr: *mut core::ffi::c_void = ptr::null_mut();
    unsafe {
        GetAce(dacl_ptr, 0, &mut ace_ptr).map_err(|e| format!("GetAce(0) failed: {e}"))?;
    }
    if ace_ptr.is_null() {
        return Err("GetAce returned null".into());
    }
    let header = unsafe { &*(ace_ptr as *const ACE_HEADER) };
    if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
        return Err(format!(
            "ACE type must be ACCESS_ALLOWED (0), got {}",
            header.AceType
        ));
    }
    if header.AceFlags & INHERITED_ACE_FLAG != 0 {
        return Err("ACE has INHERITED_ACE flag".into());
    }
    // Reject any inherit-related flags on the explicit ACE.
    if header.AceFlags != 0 {
        return Err(format!(
            "ACE flags must be 0 (no inherit/propagate), got {:#x}",
            header.AceFlags
        ));
    }
    let ace = unsafe { &*(ace_ptr as *const ACCESS_ALLOWED_ACE) };
    if ace.Mask != access_mask {
        return Err(format!(
            "ACE mask mismatch: actual={:#x} expected={:#x}",
            ace.Mask, access_mask
        ));
    }
    // SID starts at SidStart field.
    let ace_sid = PSID((&raw const ace.SidStart) as *mut _);
    if !unsafe { IsValidSid(ace_sid) }.as_bool() {
        return Err("ACE SID invalid".into());
    }
    if unsafe { EqualSid(ace_sid, token.psid()) }.is_err() {
        return Err("ACE SID is not current TokenUser".into());
    }
    Ok(())
}

struct LocalFreeGuard(PSECURITY_DESCRIPTOR);
impl Drop for LocalFreeGuard {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 .0 as *mut _)));
            }
        }
    }
}

/// Convenience: verify kernel mutex handle has private_rw protected DACL.
pub fn verify_mutex_private_rw(handle: HANDLE, token: &CurrentTokenUser) -> Result<(), String> {
    let mask = expected_access_mask(
        ObjectClass::KernelMutex,
        PathKind::File,
        ProtectedProfile::PrivateRw,
    )?;
    verify_protected_on_handle(handle, SE_KERNEL_OBJECT, token, mask)
}

/// Convenience: apply private_rw protected DACL to file/dir handle.
pub fn set_file_protected(
    handle: HANDLE,
    kind: PathKind,
    profile: ProtectedProfile,
    token: &CurrentTokenUser,
) -> Result<(), String> {
    let mask = expected_access_mask(ObjectClass::File, kind, profile)?;
    set_protected_on_handle(handle, SE_FILE_OBJECT, token, mask)
}

pub fn verify_file_protected(
    handle: HANDLE,
    kind: PathKind,
    profile: ProtectedProfile,
    token: &CurrentTokenUser,
) -> Result<(), String> {
    let mask = expected_access_mask(ObjectClass::File, kind, profile)?;
    verify_protected_on_handle(handle, SE_FILE_OBJECT, token, mask)
}
