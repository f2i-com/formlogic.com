//! FormLogic's sandbox launcher.
//!
//! This is the `formlogic-runtime` binary PHP spawns (`SandboxRunner.php`). It
//! speaks the same command line and the same stdio protocol the native runtime
//! spoke, so nothing on the PHP side changed — but it no longer contains a
//! JavaScript engine. It contains a WebAssembly *guest* (../guest, the zipp engine
//! compiled for WASI) and runs it under wasmtime:
//!
//! * **Linear-memory ceiling.** A `StoreLimits` cap on the instance's memory,
//!   enforced by the wasm runtime. The engine's own heap accounting still raises a
//!   catchable `RangeError` at the configured `--heap-mb`; this is the hard wall
//!   behind it, and it holds even if that accounting is wrong.
//! * **Fuel.** A compute budget metered by the generated code, independent of the
//!   interpreter it bounds. Waiting on PHP (the host-call lane) costs none.
//! * **Epoch.** A wall-clock deadline from a timer thread, as the last resort.
//! * **No capabilities.** The WASI context has stdio, the clock and randomness.
//!   No preopened directory, no environment, no network: there is no filesystem
//!   for `std::fs` inside the guest to reach, which is why the prelude is read
//!   HERE, on the trusted side, and handed across as an argument.
//!
//! The guest is precompiled at build time (build.rs) and embedded, so starting
//! one is a deserialise, not a compile. PHP spawns one per evaluation batch.

use std::io::Write;
use std::time::Duration;

use wasmtime::{Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, Trap};
use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;

include!("engine_config.rs");

/// The compiled guest. Produced by build.rs for exactly this target.
static GUEST: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/guest.cwasm"));

/// Hard linear-memory ceiling. Well above the engine's default 64 MiB heap
/// accounting (and the 128 MiB an onSubmit script gets) — the engine's estimate
/// does not include allocator overhead or the program's own working set, and this
/// wall is meant to be hit only when that accounting has failed, not by legitimate
/// headroom.
const DEFAULT_MEMORY_MB: u64 = 512;

/// Compute backstop. zipp's own step budget (200M steps by default, set in the
/// guest) is the one that ordinarily fires; each JS step is tens of wasm
/// instructions, so this is comfortably above it and only ever trips when the
/// interpreter has stopped counting.
const DEFAULT_FUEL: u64 = 50_000_000_000;

/// Wall-clock backstop. PHP's watchdog kills a runaway guest in single-digit
/// seconds; this only matters if the watchdog itself is gone. It keeps running
/// while the guest waits on PHP for a host call, hence the generosity.
const DEFAULT_DEADLINE_MS: u64 = 300_000;

struct HostState {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
}

fn main() {
    let mut prelude_path: Option<String> = None;
    let mut memory_mb = DEFAULT_MEMORY_MB;
    let mut fuel = DEFAULT_FUEL;
    let mut deadline_ms = DEFAULT_DEADLINE_MS;
    // Passed through to the guest untouched.
    let mut guest_args: Vec<String> = vec!["formlogic-runtime-guest".into()];

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--prelude" if i + 1 < args.len() => {
                prelude_path = Some(args[i + 1].clone());
                i += 2;
            }
            "--memory-mb" if i + 1 < args.len() => {
                memory_mb = args[i + 1].parse().unwrap_or(DEFAULT_MEMORY_MB);
                i += 2;
            }
            "--fuel" if i + 1 < args.len() => {
                fuel = args[i + 1].parse().unwrap_or(DEFAULT_FUEL);
                i += 2;
            }
            "--deadline-ms" if i + 1 < args.len() => {
                deadline_ms = args[i + 1].parse().unwrap_or(DEFAULT_DEADLINE_MS);
                i += 2;
            }
            // Guest-owned knobs: the engine's heap accounting and step budget.
            "--heap-mb" | "--max-steps" if i + 1 < args.len() => {
                guest_args.push(args[i].clone());
                guest_args.push(args[i + 1].clone());
                i += 2;
            }
            other if !other.starts_with("--") && prelude_path.is_none() => {
                prelude_path = Some(other.to_string());
                i += 1;
            }
            _ => i += 1,
        }
    }

    let prelude = match prelude_path {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) => return emit_done_error(&format!("cannot read the prelude at {path}: {e}")),
        },
        None => return emit_done_error("no prelude was supplied"),
    };
    guest_args.push("--prelude-source".into());
    guest_args.push(prelude);

    if let Err(e) = run(guest_args, memory_mb, fuel, deadline_ms) {
        emit_done_error(&e);
    }
}

fn run(guest_args: Vec<String>, memory_mb: u64, fuel: u64, deadline_ms: u64) -> Result<(), String> {
    let engine = Engine::new(&base_engine_config()).map_err(|e| format!("sandbox engine: {e}"))?;

    // SAFETY: `GUEST` was produced by build.rs from the tracked guest module with
    // this same configuration and embedded into this binary at build time. It is
    // not, and can never be, data that arrived at run time.
    let module = unsafe { Module::deserialize(&engine, GUEST) }
        .map_err(|e| format!("sandbox guest did not load: {e}"))?;

    let wasi = WasiCtxBuilder::new()
        .inherit_stdin()
        .inherit_stdout()
        .inherit_stderr()
        .args(&guest_args)
        .build_p1();

    let limits = StoreLimitsBuilder::new()
        .memory_size((memory_mb as usize).saturating_mul(1024 * 1024))
        .instances(1)
        .tables(8)
        .memories(1)
        .trap_on_grow_failure(false)
        .build();

    let mut store = Store::new(&engine, HostState { wasi, limits });
    store.limiter(|s| &mut s.limits);
    store
        .set_fuel(fuel)
        .map_err(|e| format!("sandbox fuel: {e}"))?;
    store.set_epoch_deadline(1);

    // The wall clock. One tick after `deadline_ms` trips the deadline above; the
    // thread is detached and dies with the process either way.
    let ticker = engine.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(deadline_ms));
        ticker.increment_epoch();
    });

    let mut linker: Linker<HostState> = Linker::new(&engine);
    wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s: &mut HostState| &mut s.wasi)
        .map_err(|e| format!("sandbox WASI: {e}"))?;

    let instance = linker
        .instantiate(&mut store, &module)
        .map_err(|e| format!("sandbox instantiate: {e}"))?;
    let start = instance
        .get_typed_func::<(), ()>(&mut store, "_start")
        .map_err(|e| format!("sandbox entry: {e}"))?;

    match start.call(&mut store, ()) {
        Ok(()) => Ok(()),
        Err(e) => {
            // A clean `process::exit` from the guest is not a failure.
            if let Some(exit) = e.downcast_ref::<wasmtime_wasi::I32Exit>() {
                if exit.0 == 0 {
                    return Ok(());
                }
                return Err(format!("sandbox exited with status {}", exit.0));
            }
            Err(match e.downcast_ref::<Trap>() {
                Some(Trap::OutOfFuel) => "sandbox compute budget exhausted".to_string(),
                Some(Trap::Interrupt) => "sandbox wall-clock deadline exceeded".to_string(),
                Some(Trap::UnreachableCodeReached) => {
                    "sandbox aborted (guest panic or allocation failure)".to_string()
                }
                Some(t) => format!("sandbox trap: {t}"),
                // Alternate form: wasmtime wraps a host-call error in a backtrace
                // context, and plain Display prints only that outermost layer —
                // PHP would receive a frame listing and lose the cause.
                None => format!("sandbox failed: {e:#}"),
            })
        }
    }
}

/// The wire's failure frame, in the launcher's own voice. The guest emits its own
/// `done` when it finishes; this is for the cases where it cannot — a trap, a
/// deadline, a module that would not load — and PHP treats either the same way.
fn emit_done_error(message: &str) {
    let mut escaped = String::with_capacity(message.len() + 8);
    for ch in message.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' | '\r' | '\t' => escaped.push(' '),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    // The leading newline is deliberate. The guest writes its stdout in ≤4 KiB
    // chunks, and a budget that expires between two chunks of a large frame
    // would otherwise glue this onto a partial line — PHP would then discard
    // BOTH and report a generic crash instead of the budget error. PHP already
    // skips blank lines, so an empty line costs nothing.
    let _ = writeln!(out, "\n{{\"type\":\"done\",\"error\":\"{escaped}\"}}");
    let _ = out.flush();
}
