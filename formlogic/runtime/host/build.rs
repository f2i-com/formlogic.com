//! Precompile the guest at build time.
//!
//! `formlogic-runtime-guest.wasm` (tracked beside this file; produced from
//! ../guest) is compiled here with Cranelift into wasmtime's serialised form and
//! embedded by main.rs. Two things about the compile are deliberate:
//!
//! * The target triple is set EXPLICITLY, to the triple this launcher is being
//!   built for. When wasmtime is asked to compile for the machine it is running
//!   on it enables that machine's ISA extensions — AVX-512 on this workstation —
//!   and the artifact would then refuse to load, or fault, on a server without
//!   them. Naming the triple disables host detection and produces baseline
//!   x86-64 code that runs anywhere the binary does.
//! * The configuration is the shared one from src/engine_config.rs, because
//!   wasmtime checks it at deserialise time and a mismatch is a start-up error
//!   on every request, not a warning.

include!("src/engine_config.rs");

fn main() {
    let guest = "formlogic-runtime-guest.wasm";
    println!("cargo:rerun-if-changed={guest}");
    println!("cargo:rerun-if-changed=src/engine_config.rs");

    let wasm = std::fs::read(guest).unwrap_or_else(|e| {
        panic!(
            "cannot read {guest}: {e}\n\
             Build the guest first — `cargo build --release` in ../guest — and copy\n\
             target/wasm32-wasip1/release/formlogic-runtime-guest.wasm here (see ../README.md)."
        )
    });

    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let mut config = base_engine_config();
    config
        .target(&target)
        .unwrap_or_else(|e| panic!("wasmtime cannot target {target}: {e}"));

    // On its own thread with a large stack. zipp's interpreter dispatch is one
    // enormous function, and Cranelift's instruction selection and register
    // allocation recurse deeply over it — deeply enough to overflow the 1 MiB a
    // Windows main thread gets. The compile is otherwise ordinary.
    let compiled = std::thread::Builder::new()
        .name("precompile-guest".into())
        .stack_size(512 * 1024 * 1024)
        .spawn(move || {
            let engine =
                wasmtime::Engine::new(&config).expect("wasmtime engine for precompilation");
            engine
                .precompile_module(&wasm)
                .unwrap_or_else(|e| panic!("precompiling the guest failed: {e}"))
        })
        .expect("spawn precompile thread")
        .join()
        .expect("precompile thread panicked");

    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"))
        .join("guest.cwasm");
    std::fs::write(&out, compiled).expect("write guest.cwasm");
}
