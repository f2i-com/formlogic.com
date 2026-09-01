# formlogic-runtime

The backend's expression/script sandbox. PHP spawns this as a child process and
talks newline-delimited JSON to it over stdio; `backend/src/Services/SandboxRunner.php`
is the other half of that protocol.

It embeds [zipp](https://github.com/f2i-com/zipp.org)'s `zipp-vm` with the
`safe-sandbox` feature: an interpreter-only profile with no JIT, no host modules,
and an instruction budget enforced inside the interpreter. The engine it replaced
(QuickJS with `--std`) shipped `std`/`os` — filesystem, `popen`, `getenv`,
`urlGet` — which the JS harness had to capture and delete from the global object
before a guest ran. There is no such list to keep in step here, because there is
nothing to delete.

## Why its own workspace

It pins `zipp-vm` with `default-features = false` so the JIT never compiles in.
The desktop's `src-tauri` crate depends on `zipp-vm` too; sharing a workspace
would union their feature sets, and Cargo feature unification would quietly hand
this sandbox a JIT. A separate workspace makes that impossible rather than
merely unlikely.

## Modes

- `eval` — one or more expressions against a shared context. Each expression runs
  through indirect eval inside its own try/catch, so a syntax error in one
  expression cannot take down the batch.
- `script` — a user `onSubmit(ctx)` script. `ctx.db` / `ctx.http` / `ctx.utils`
  are dispatched back to PHP over the same stdio channel, so all IO and its
  SSRF/DNS-pinning guards stay on the host side. The guest reaches the host
  through a Rust-side closure and never touches the transport itself; `print` and
  `console` are stubs, so a guest cannot forge a reply frame.
  (`backend/tests/Integration/SandboxScriptModeTest.php` pins all of this.)

## Building

The binaries under `backend/bin/runtime/` are vendored, so a deployment does not
need a Rust toolchain. Rebuild both when the engine revision changes — and change
them together with `ui/vendor/zipp-wasm/` and the desktop's `zipp-vm` pin, since
an expression is supposed to mean the same thing in all three.

Windows:

```sh
cargo build --release
cp target/release/formlogic-runtime.exe \
   ../backend/bin/runtime/formlogic-runtime-windows-x86_64.exe
```

Linux (`x86_64-unknown-linux-musl`, cross-built from Windows). The linker flags
are required: without them the build reaches for a GNU `cc` that is not there.
musl gives a **static-PIE** binary with no libc dependency — the same
"copy it onto any server and it runs" property the vendored `qjs` build had.

```sh
rustup target add x86_64-unknown-linux-musl
RUSTFLAGS="-C linker-flavor=ld.lld -C linker=rust-lld" \
  cargo build --release --target x86_64-unknown-linux-musl
cp target/x86_64-unknown-linux-musl/release/formlogic-runtime \
   ../backend/bin/runtime/formlogic-runtime-linux-x86_64
```

Zip extraction drops the execute bit on the Linux binary; `install.php` checks for
it and offers the `chmod +x` if it cannot restore it itself.

## Parity

`docs/contracts/formlogic-expression-corpus.json` is the cross-runtime authority:
the same cases are asserted by this runtime (via PHP), by the desktop, and by the
browser wasm build, with identical expected values. See
`backend/scripts/build-expression-corpus.php` for how it is regenerated.
