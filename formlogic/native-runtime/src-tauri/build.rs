fn main() {
    tauri_build::build();

    // tests/bridge_ipc.rs runs the commands on Tauri's mock runtime. Anything that links
    // Tauri's window code imports Common Controls 6, and Windows gives that version only to
    // a program whose manifest asks for it; without one the test program does not start
    // (STATUS_ENTRYPOINT_NOT_FOUND). tauri-build puts that manifest in the app itself. This
    // puts the same one in the integration tests, and in nothing else.
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows && msvc {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("tests")
            .join("common-controls-v6.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
    }
}
