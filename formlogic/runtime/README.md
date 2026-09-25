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

The browser runs the same engine as its own wasm module (`ui/vendor/zipp-wasm/`,
installed from the Softn release, which names its ZIPP release and revision in
`SOURCE.json`). The shared corpus
(`docs/contracts/formlogic-expression-corpus.json`) is asserted against both so
an expression means the same thing everywhere; `scripts/check-expression-parity.mjs`
is the comparator, and it also requires both legs to have run that one ZIPP release.

The guest names no ZIPP release of its own. `guest/Cargo.toml` takes `zipp-vm` by
path from `.runtime-source/zipp/src`, which `scripts/zipp-source.mjs` fills with
the source of the ZIPP release the **installed Softn release** names
(`.runtime-source/softn-release/current.json` `zipp`) and verifies: the commit is
the recorded revision, the workspace version is the release's, and the sources
have LF endings. So a new ZIPP release reaches the server with no commit here,
and the server and the browser are always one ZIPP release. Nothing built is
committed: the guest wasm, its `Cargo.lock` and both launchers are generated,
and `backend/bin/runtime/SOURCE.json` records where every byte came from (the
ZIPP release and commit, the Softn archive, the toolchain, each digest, and
which CI run or machine built it).

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

CI builds the sandbox on every run (`.github/actions/prepare-sandbox-runtime`): the
guest and the Linux launcher on ubuntu-24.04, and, for packaging, the Windows
launcher on windows-2022 embedding that same guest. Locally,
`scripts/build-runtime.sh` does the same, after a Softn release is installed
(`node scripts/fetch-softn-release.mjs`, or `SOFTN_RELEASE_ARCHIVE=<zip>`):

```sh
ZIPP_SOURCE_DIR=../zipp.org scripts/build-runtime.sh all   # or without ZIPP_SOURCE_DIR: clone the tag
scripts/build-runtime.sh check
```

`all` runs these steps, which can also be named one by one:

- `zipp-source` puts the ZIPP release's source at `.runtime-source/zipp/src`:
  a shallow clone of its tag, or, with `ZIPP_SOURCE_DIR`, `git archive` of the
  recorded commit from a local zipp.org checkout (read-only). Either way with
  `core.autocrlf=false`, and verified before anything builds from it. A clone is
  proved by git every time (HEAD, and no changed or extra file); an extracted
  tree is reused only while a digest of every file, taken at extraction, still
  matches, so an edited tree is extracted again rather than built as the release.
- `guest` seeds `guest/Cargo.lock` from ZIPP's own lock and runs `cargo update
  --workspace`, which adds only the guest; a shared package changing version, or
  a package ZIPP does not lock, fails. The seed is ZIPP's root workspace lock (the
  one its release CI builds the CLI with, `--locked`), not `crates/zipp-wasm`'s:
  the browser engine's lock has no `serde_json` (nor `serde`, `itoa`, `zmij`),
  which the guest needs for its NDJSON, so seeding from it would fail that rule.
  The two locks differ only by semver-compatible releases in what the guest runs
  (v0.0.18: `num-integer` 0.1.46 against 0.1.47, `tinyvec` 1.11.0 against 1.12.0),
  and the parity corpus is what shows it makes no difference. Then `cargo build --release --locked`
  (`.cargo/config.toml` pins `wasm32-wasip1`) and a copy to
  `host/formlogic-runtime-guest.wasm`, the input of the launcher's `build.rs`.
- `windows` (on Windows only) builds `host/` natively and copies
  `formlogic-runtime.exe` to `backend/bin/runtime/formlogic-runtime-windows-x86_64.exe`.
  `build.rs` precompiles the guest with Cranelift for the build's `TARGET`, named
  explicitly, so the artifact is baseline x86-64 and not tuned to the builder's
  ISA extensions, and embeds it.
- `linux` builds the static musl launcher: natively where `musl-gcc` exists
  (CI), otherwise in Docker (`rust:<toolchain>-bookworm` plus `musl-tools`).
  wasmtime's runtime carries a small C helper, and cross-compiling C for musl
  from Windows needs a toolchain a Windows machine does not have; a container
  has it for free. A dynamically linked result is refused (read from the ELF
  program headers, so no `file` is needed). On Windows without Docker, `all`
  says the Linux launcher was skipped, drops one left from an earlier build
  unless it embeds the guest just built, and still smoke-tests and records the
  Windows launcher; packaging then waits for a Linux launcher.
- `smoke` pipes one eval job through every launcher this machine can run (the
  Linux one in a container on Windows): `validators.email(...) ? 40 + 2 : -1`
  through the prelude must give 42, the same calculated field
  `scripts/smoke-dist.mjs` submits through the whole app.
- `provenance` merges the records each step left in `.runtime-source/sandbox/`
  into `backend/bin/runtime/SOURCE.json`, refusing a guest built from another ZIPP
  than the installed release names, or a launcher that embeds another guest.
- `check` (`node scripts/runtime-provenance.mjs check`) proves the launchers and
  the guest are the ones SOURCE.json records, and that it is the installed Softn
  release's ZIPP. It also holds SOURCE.json to the installed Softn archive, which
  changes no sandbox byte but is what a packaged zip claims it was built against:
  when a newer Softn release names the same ZIPP, recording again (`provenance`)
  is the whole fix, and the message says so. `check --deployed` asks only what a
  running backend needs (the recorded launchers, of the installed release's ZIPP),
  which is what `install.sh` asks of a launcher it finds already in place.

The toolchain is the one ZIPP's release was built with: the `rustc` line of the
installed ZIPP bundle's `BUILD-INFO.txt` (`ui/vendor/zipp-wasm/`), which the Softn
release's ZIPP record must repeat; the script installs that rustup toolchain's
targets when they are missing.

Without Rust, take a built sandbox instead. It must be built from the ZIPP
release the installed Softn release names (`node scripts/zipp-source.mjs
--identity` prints it); `provenance` and `check` refuse any other:

- A FormLogic release zip carries both launchers and their SOURCE.json under
  `api/bin/runtime/` (and says which ZIPP release in `engine-identity.json`
  `serverSandbox`); copy that directory to `backend/bin/runtime/`. A Package run's
  `formlogic-dist` artifact is the same zip and is kept 30 days; a GitHub release
  keeps it for good.
- A Package run's own sandbox artifacts are kept only 7 days (they exist to hand
  the build between that run's jobs): `gh run download <Package run id> -R
  f2i-com/formlogic.com -n <artifact> -D .` for `sandbox-guest` and
  `sandbox-linux` (and `sandbox-windows`) from the repository root, then `chmod +x
  formlogic/backend/bin/runtime/formlogic-runtime-linux-x86_64` and `node
  scripts/runtime-provenance.mjs provenance`. That run must have frozen a Softn
  release naming the same ZIPP release as the one installed here (fetch that
  release with `SOFTN_RELEASE=<its tag>` if the latest names another).

Zip extraction drops the execute bit on the Linux binary; `install.php` checks
for it and offers the `chmod +x` if it cannot restore it itself.

Guest bytes depend on where the guest was built (a panic location keeps the
path of its source), so a Windows-built guest differs from CI's Linux-built one;
both CI launchers embed the one Linux-built guest, and a local build records
`build.by` `local`, which `scripts/package-dist.mjs --release` refuses.

## Why wasmtime 44

wasmtime is FormLogic's own choice, fixed by the committed `host/Cargo.toml`
(`"44"`) and `host/Cargo.lock` (44.0.3); the toolchain is not. The toolchain
follows the installed ZIPP release's BUILD-INFO `rustc` with no commit here, and
a newer rustc builds wasmtime 44 unchanged. 44 is the newest line whose minimum
Rust (`rust-version` 1.92.0) the toolchain ZIPP v0.0.18 through v0.0.21 were built with (1.92.0)
meets. Moving to a newer line (wasmtime 48 needs 1.95.0) is a FormLogic commit to
`host/Cargo.toml` and `host/Cargo.lock`, and builds only once the installed ZIPP
release's toolchain reaches that line's minimum.
