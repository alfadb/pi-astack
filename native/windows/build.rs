fn main() {
    println!("cargo:rerun-if-env-changed=PI_ASTACK_SOURCE_COMMIT");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_SOURCE_TREE_SHA256");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_BUILD_ID");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_TOOLCHAIN_ID");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_BUILD_MODE");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_REPRODUCIBILITY");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_NATIVE_TESTS");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_CLIPPY");
    println!("cargo:rerun-if-env-changed=PI_ASTACK_BUILD_CONFIG_SHA256");
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/atomic_file.rs");
    println!("cargo:rerun-if-changed=src/pathutil.rs");
    println!("cargo:rerun-if-changed=src/protected_path.rs");
    println!("cargo:rerun-if-changed=src/security.rs");
    println!("cargo:rerun-if-changed=src/bin/mutex_squat_helper.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=rust-toolchain.toml");
    println!("cargo:rerun-if-changed=.cargo/config.toml");

    // Bind provenance into the binary at compile time. Build driver must supply these.
    let source_commit = required_env("PI_ASTACK_SOURCE_COMMIT");
    let source_tree = required_env("PI_ASTACK_SOURCE_TREE_SHA256");
    let build_id = required_env("PI_ASTACK_BUILD_ID");
    let toolchain_id = required_env("PI_ASTACK_TOOLCHAIN_ID");
    let build_mode = required_env("PI_ASTACK_BUILD_MODE");
    let reproducibility = required_env("PI_ASTACK_REPRODUCIBILITY");
    let native_tests = required_env("PI_ASTACK_NATIVE_TESTS");
    let clippy = required_env("PI_ASTACK_CLIPPY");
    let build_config_sha256 = required_env("PI_ASTACK_BUILD_CONFIG_SHA256");

    assert!(
        source_commit.len() == 40 && source_commit.chars().all(|c| c.is_ascii_hexdigit()),
        "PI_ASTACK_SOURCE_COMMIT must be 40-char hex"
    );
    assert!(
        source_tree.len() == 64 && source_tree.chars().all(|c| c.is_ascii_hexdigit()),
        "PI_ASTACK_SOURCE_TREE_SHA256 must be 64-char hex"
    );
    assert!(
        toolchain_id.len() == 64 && toolchain_id.chars().all(|c| c.is_ascii_hexdigit()),
        "PI_ASTACK_TOOLCHAIN_ID must be 64-char hex"
    );
    assert!(
        !build_id.is_empty() && build_id.len() <= 128,
        "PI_ASTACK_BUILD_ID must be 1..128 chars"
    );
    assert!(
        build_mode == "development" || build_mode == "production",
        "PI_ASTACK_BUILD_MODE must be development|production"
    );
    assert!(
        reproducibility == "skipped" || reproducibility == "dual_clean_match",
        "PI_ASTACK_REPRODUCIBILITY must be skipped|dual_clean_match"
    );
    assert!(
        native_tests == "passed",
        "PI_ASTACK_NATIVE_TESTS must be passed (gates-after-build identity)"
    );
    assert!(
        clippy == "passed",
        "PI_ASTACK_CLIPPY must be passed (gates-after-build identity)"
    );
    assert!(
        build_config_sha256.len() == 64
            && build_config_sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
        "PI_ASTACK_BUILD_CONFIG_SHA256 must be lowercase sha256 hex"
    );

    println!("cargo:rustc-env=PI_ASTACK_SOURCE_COMMIT={source_commit}");
    println!("cargo:rustc-env=PI_ASTACK_SOURCE_TREE_SHA256={source_tree}");
    println!("cargo:rustc-env=PI_ASTACK_BUILD_ID={build_id}");
    println!("cargo:rustc-env=PI_ASTACK_TOOLCHAIN_ID={toolchain_id}");
    println!("cargo:rustc-env=PI_ASTACK_BUILD_MODE={build_mode}");
    println!("cargo:rustc-env=PI_ASTACK_REPRODUCIBILITY={reproducibility}");
    println!("cargo:rustc-env=PI_ASTACK_NATIVE_TESTS={native_tests}");
    println!("cargo:rustc-env=PI_ASTACK_CLIPPY={clippy}");
    println!("cargo:rustc-env=PI_ASTACK_BUILD_CONFIG_SHA256={build_config_sha256}");
    // First support matrix freezes N-API 9.
    println!("cargo:rustc-env=NAPI_VERSION=9");

    napi_build::setup();
}

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the build driver"))
}
