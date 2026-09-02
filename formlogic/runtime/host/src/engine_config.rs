// Shared between build.rs (which COMPILES the guest) and main.rs (which only
// DESERIALISES it). wasmtime refuses a precompiled module whose configuration
// differs from the engine loading it, so every knob that affects the artifact
// lives here, once, and both sides `include!` it. Adding a setting in one place
// but not the other is exactly the mismatch this file prevents.

/// The engine configuration the guest artifact is compiled for and loaded with.
fn base_engine_config() -> wasmtime::Config {
    let mut config = wasmtime::Config::new();

    // Fuel: a deterministic COMPUTE bound the guest cannot influence. zipp keeps
    // its own JS-level step budget, but that is enforced by the very interpreter
    // it bounds; fuel is metered by the wasm code Cranelift emitted, so a defect
    // that spins the interpreter without counting a step still runs out. Blocking
    // in a host call (the RPC lane, waiting on PHP) burns none of it — which is
    // the behaviour the PHP watchdog approximates by pausing around host calls.
    config.consume_fuel(true);

    // Epoch: the WALL-CLOCK backstop, incremented by a timer thread in the
    // launcher. Generous by design, since it does keep ticking while the guest
    // waits on PHP; it exists for the case where every other layer has failed.
    config.epoch_interruption(true);

    // Pinned explicitly because the DEFAULT is read from the environment:
    // `Config::new()` consults WASMTIME_BACKTRACE_DETAILS, and the resulting
    // flag is part of the artifact's compatibility check at deserialise time. A
    // launcher built on a workstation with that variable set would refuse to
    // load its own guest on every server without it ("compiled with WebAssembly
    // backtrace support but it is not enabled for the host") — a total outage
    // of form logic caused by a developer's shell profile.
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Disable);

    // Proposal switches are left at wasmtime's defaults for a build without the
    // `threads`/`gc` features: no shared memory, no threads. The guest is a
    // single-threaded WASI command and links nothing that needs them.

    config
}
