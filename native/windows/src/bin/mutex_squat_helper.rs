//! Real OS helper for durable-dacl smoke (not a mock).
//!
//! Subcommands:
//!   squat <volume_hex16> <file_id_hex32> [hold_ms] [ready_file]
//!     Create Global\pi-astack-retained-v1-<sidhash8>-<vol>-<fid> with default DACL and hold.
//!     Writes ready JSON to ready_file (or stdout if omitted).
//!
//!   set-foreign-group <ordinary_dos_path>
//!     Set file/dir group SID to BUILTIN\Users while keeping owner; used to prove
//!     setProtectedPath owner/group convergence. Exit 0 on success.

#![deny(clippy::all)]

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::process;
use std::thread;
use std::time::Duration;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER, HANDLE};
use windows::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows::Win32::Security::{
    CopySid, GetLengthSid, GetTokenInformation, IsValidSid, LookupAccountNameW, TokenUser,
    GROUP_SECURITY_INFORMATION, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Threading::{CreateMutexW, GetCurrentProcess, OpenProcessToken};

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn fnv1a32(data: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in data {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn json_escape(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn write_ready(ready_file: Option<&str>, line: &str) {
    if let Some(path) = ready_file {
        let tmp = format!("{path}.{}.tmp", process::id());
        fs::write(&tmp, line).unwrap_or_else(|e| {
            eprintln!("write ready tmp failed: {e}");
            process::exit(1);
        });
        fs::rename(&tmp, path).unwrap_or_else(|e| {
            eprintln!("rename ready failed: {e}");
            process::exit(1);
        });
    } else {
        let _ = io::stdout().write_all(line.as_bytes());
        let _ = io::stdout().flush();
    }
}

fn current_sid_hash8() -> Result<String, String> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| format!("OpenProcessToken: {e}"))?;
    }
    let mut needed: u32 = 0;
    let first = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut needed) };
    if first.is_ok() {
        unsafe {
            let _ = CloseHandle(token);
        }
        return Err("GetTokenInformation size query unexpectedly ok".into());
    }
    let err = unsafe { GetLastError() };
    if err != ERROR_INSUFFICIENT_BUFFER && needed == 0 {
        unsafe {
            let _ = CloseHandle(token);
        }
        return Err(format!("TokenUser size query failed win32={}", err.0));
    }
    let mut buf = vec![0u8; needed as usize];
    let got = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut _),
            needed,
            &mut needed,
        )
    };
    unsafe {
        let _ = CloseHandle(token);
    }
    got.map_err(|e| format!("GetTokenInformation: {e}"))?;
    let token_user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let sid = token_user.User.Sid;
    if sid.0.is_null() || !unsafe { IsValidSid(sid) }.as_bool() {
        return Err("invalid TokenUser SID".into());
    }
    let sid_len = unsafe { GetLengthSid(sid) };
    if sid_len == 0 || sid_len > 1024 {
        return Err(format!("bad SID length {sid_len}"));
    }
    let mut sid_bytes = vec![0u8; sid_len as usize];
    unsafe {
        CopySid(
            sid_len,
            windows::Win32::Security::PSID(sid_bytes.as_mut_ptr() as *mut _),
            sid,
        )
        .map_err(|e| format!("CopySid: {e}"))?;
    }
    Ok(format!("{:08x}", fnv1a32(&sid_bytes)))
}

fn cmd_squat(args: &[String]) {
    if args.len() < 2 || args.len() > 4 {
        eprintln!("usage: ... squat <volume_hex16> <file_id_hex32> [hold_ms] [ready_file]");
        process::exit(2);
    }
    let volume = &args[0];
    let file_id = &args[1];
    let hold_ms: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30_000);
    let ready_file = args.get(3).map(|s| s.as_str());

    if volume.len() != 16 || !volume.chars().all(|c| c.is_ascii_hexdigit()) {
        eprintln!("volume_hex16 must be 16 hex chars");
        process::exit(2);
    }
    if file_id.len() != 32 || !file_id.chars().all(|c| c.is_ascii_hexdigit()) {
        eprintln!("file_id_hex32 must be 32 hex chars");
        process::exit(2);
    }

    let sid_hash = match current_sid_hash8() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("sid hash failed: {e}");
            process::exit(1);
        }
    };

    let name = format!(r"Global\pi-astack-retained-v1-{sid_hash}-{volume}-{file_id}");
    let wide = to_wide(&name);

    // Default DACL (NULL security attributes) — deliberately weak/not protected.
    let created = unsafe { CreateMutexW(None, true, PCWSTR(wide.as_ptr())) };
    let handle = match created {
        Ok(h) if !h.is_invalid() => h,
        Ok(_) => {
            eprintln!("CreateMutexW INVALID_HANDLE_VALUE");
            process::exit(1);
        }
        Err(err) => {
            eprintln!("CreateMutexW failed: {err}");
            process::exit(1);
        }
    };

    let line = format!(
        "{{\"ok\":true,\"mutex_name\":{},\"sid_hash8\":\"{sid_hash}\",\"hold_ms\":{hold_ms}}}\n",
        json_escape(&name)
    );
    write_ready(ready_file, &line);

    thread::sleep(Duration::from_millis(hold_ms));

    unsafe {
        let _ = CloseHandle(handle);
    }
}

fn lookup_builtin_users_sid() -> Result<Vec<u8>, String> {
    // Resolve "BUILTIN\\Users" to SID bytes.
    let name = to_wide(r"BUILTIN\Users");
    let mut sid_needed: u32 = 0;
    let mut domain_needed: u32 = 0;
    let mut use_type = SID_NAME_USE(0);
    let first = unsafe {
        LookupAccountNameW(
            None,
            PCWSTR(name.as_ptr()),
            None,
            &mut sid_needed,
            None,
            &mut domain_needed,
            &mut use_type,
        )
    };
    if first.is_ok() {
        return Err("LookupAccountNameW unexpectedly succeeded with empty buffers".into());
    }
    if sid_needed == 0 {
        let err = unsafe { GetLastError() };
        return Err(format!("LookupAccountNameW size failed win32={}", err.0));
    }
    let mut sid_buf = vec![0u8; sid_needed as usize];
    let mut domain_buf = vec![0u16; domain_needed as usize + 1];
    unsafe {
        LookupAccountNameW(
            None,
            PCWSTR(name.as_ptr()),
            Some(PSID(sid_buf.as_mut_ptr() as *mut _)),
            &mut sid_needed,
            Some(PWSTR(domain_buf.as_mut_ptr())),
            &mut domain_needed,
            &mut use_type,
        )
        .map_err(|e| format!("LookupAccountNameW failed: {e}"))?;
    }
    if !unsafe { IsValidSid(PSID(sid_buf.as_ptr() as *mut _)) }.as_bool() {
        return Err("resolved BUILTIN\\Users SID invalid".into());
    }
    Ok(sid_buf)
}

fn cmd_set_foreign_group(args: &[String]) {
    if args.len() != 1 {
        eprintln!("usage: ... set-foreign-group <ordinary_dos_path>");
        process::exit(2);
    }
    let path = &args[0];
    let mut sid = match lookup_builtin_users_sid() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("lookup BUILTIN\\Users failed: {e}");
            process::exit(1);
        }
    };
    let wide = to_wide(path);
    let err = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            GROUP_SECURITY_INFORMATION,
            None,
            Some(PSID(sid.as_mut_ptr() as *mut _)),
            None,
            None,
        )
    };
    if err.0 != 0 {
        eprintln!("SetNamedSecurityInfoW(GROUP) failed win32={}", err.0);
        process::exit(1);
    }
    let line = format!(
        "{{\"ok\":true,\"path\":{},\"group\":\"BUILTIN\\\\Users\"}}\n",
        json_escape(path)
    );
    let _ = io::stdout().write_all(line.as_bytes());
    let _ = io::stdout().flush();
}

fn main() {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!(
      "usage:\n  pi-astack-mutex-squat-helper squat <vol16> <fid32> [hold_ms] [ready_file]\n  pi-astack-mutex-squat-helper set-foreign-group <path>\n  (legacy) pi-astack-mutex-squat-helper <vol16> <fid32> [hold_ms]"
    );
        process::exit(2);
    }

    // Back-compat: first arg looks like volume hex → legacy squat form.
    if args[0].len() == 16 && args[0].chars().all(|c| c.is_ascii_hexdigit()) {
        cmd_squat(&args);
        return;
    }

    let cmd = args.remove(0);
    match cmd.as_str() {
        "squat" => cmd_squat(&args),
        "set-foreign-group" => cmd_set_foreign_group(&args),
        other => {
            eprintln!("unknown subcommand: {other}");
            process::exit(2);
        }
    }
}
