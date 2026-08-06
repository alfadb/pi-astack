//! Test-only Windows N-API load-order canary.
//!
//! NOT part of the production native package / source closure / package manifest.
//! On process load (DllMain CRT init + before/at napi_register_module completion),
//! writes a marker file when `PI_ASTACK_LOAD_CANARY_MARKER` is set. Proves that
//! native load side effects complete before any post-dlopen JS check can run.

#![deny(clippy::all)]

use napi_derive::napi;
use std::env;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static INIT_OBSERVED: AtomicBool = AtomicBool::new(false);

/// Runs during native image load (before control returns to JS require/dlopen).
#[ctor::ctor]
fn on_native_load() {
    INIT_OBSERVED.store(true, Ordering::SeqCst);
    if let Ok(path) = env::var("PI_ASTACK_LOAD_CANARY_MARKER") {
        if path.is_empty() {
            return;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // Marker body is closed non-secret: phase tag + Unix epoch nanos only.
        let _ = fs::write(path, format!("native_load_side_effect:{nanos}\n"));
    }
}

#[napi]
pub fn canary_init_observed() -> bool {
    INIT_OBSERVED.load(Ordering::SeqCst)
}

#[napi]
pub fn canary_id() -> String {
    "pi-astack-windows-load-canary/v1".to_string()
}
