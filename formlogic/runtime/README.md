# formlogic-runtime

The backend's expression/script sandbox. PHP spawns `formlogic-runtime` as a
child process and talks newline-delimited JSON to it over stdio;
`backend/src/Services/SandboxRunner.php` is the other half of that protocol.

It is two crates, and the split is the security design:

| crate | builds to | what it is |
|---|---|---|
| `guest/` | `wasm32-wasip1` | the [zipp](https://github.com/f2i-com/zipp.org) engine (`safe-sandbox` profile) plus the evaluator logic, as a WASI command |
| `host/` | native (`formlogic-runtime`) | a wasmtime launcher that embeds a precompiled copy of the guest and runs it |

So the JavaScript engine that evaluates a form author's code never runs as native
code on the server. It runs inside a WebAssembly instance, behind:

- **a linear-memory ceiling** the wasm runtime enforces (`StoreLimits`, default
  512 MiB), behind the engine's own catchable heap accounting (`--heap-mb`);
- **fuel** — a compute budget metered by the generated code, so a defect that
  spins the interpreter without counting a step still runs out; waiting on PHP
  in the host-call lane burns none of it;
- **an epoch deadline** — a wall-clock backstop from a timer thread;
- **no capabilities** — the WASI context has stdio, the clock and randomness.
  No preopened directory, no environment, no network. The prelude is read by the
  launcher on the trusted side and handed across as an argument, because the
  guest cannot open a file.

The browser runs the same engine at the same revision as its own wasm module
(`ui/vendor/zipp-wasm/`), and the desktop links it natively. The shared corpus
(`docs/contracts/formlogic-expression-corpus.json`) is asserted against all three
so an expression means the same thing everywhere; `scripts/check-expression-parity.mjs`
is the comparator.

## Modes

- `eval` — one or more expressions against a shared context. Each expression runs
  through indirect eval inside its own try/catch, so a syntax error in one
  expression cannot take down the batch.
- `script` — a user `onSubmit(ctx)` script. `ctx.db` / `ctx.http` / `ctx.utils`
  are dispatched back to PHP over the same stdio channel, so all IO and its
  SSRF/DNS-pinning guards stay on the host side. The guest reaches PHP through a
  Rust-side closure inside the sandbox and never touches the transport itself;
  `print` and `console` are stubs, so a guest cannot forge a reply frame.
  (`backend/tests/Integration/SandboxScriptModeTest.php` pins all of this.)

## Command line

Unchanged from the native runtime, so PHP did not change:

```
formlogic-runtime --prelude <path> [--heap-mb N] [--max-steps N]
                  [--memory-mb N] [--fuel N] [--deadline-ms N]
```

`--heap-mb` and `--max-steps` go to the guest (the engine's accounting). The
last three are the launcher's hard limits and normally stay at their defaults.

## Building

`scripts/build-runtime.sh` does all of this; the steps, for when it cannot:

**1. The guest.** Needs the `wasm32-wasip1` target (`rustup target add wasm32-wasip1`).

```sh
cd guest && cargo build --release        # .cargo/config.toml pins the target
cp target/wasm32-wasip1/release/formlogic-runtime-guest.wasm ../host/
```

That copy in `host/` is **tracked in git**. It is the input to the launcher's
`build.rs`, and tracking it is what lets the launcher build from a clean
checkout without a wasm toolchain. It moves only when the engine revision does.

**2. The launcher, Windows.** `build.rs` precompiles the guest with Cranelift for
the build's `TARGET` — named explicitly, so the artifact is baseline x86-64 and
not tuned to this workstation's ISA extensions — and embeds it.

```sh
cd host && cargo build --release
cp target/release/formlogic-runtime.exe ../../backend/bin/runtime/formlogic-runtime-windows-x86_64.exe
```

**3. The launcher, Linux.** Built in Docker (`rust:1.92-bookworm` +
`musl-tools`), not cross-compiled: wasmtime's runtime carries a small C helper,
and cross-compiling C for musl from Windows needs a toolchain this machine does
not have. The result is a static musl binary with no libc dependency — the
"copy it onto any server and it runs" property the vendored `qjs` build had.

```sh
scripts/build-runtime.sh linux
```

Zip extraction drops the execute bit on the Linux binary; `install.php` checks
for it and offers the `chmod +x` if it cannot restore it itself.

**Rebuild all three** (guest, both launchers, and `ui/vendor/zipp-wasm/`) when
the engine revision changes — never one of them alone.

## Why wasmtime 44

The newest wasmtime line built for rustc 1.92, which is what zipp's own browser
build pins. Moving the toolchain forward moves this too.
