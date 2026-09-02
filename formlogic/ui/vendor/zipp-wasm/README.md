# zipp-wasm (vendored)

The browser half of FormLogic's expression sandbox. Author-written conditions,
calculated fields, validation rules and app-logic hooks run in this engine, in a
dedicated Web Worker, with an empty global object and no host bridge installed.

**Built from** `f2i-com/zipp.org` at **`7fd2f23d`** (v0.0.12 — the commit that
refreshed the repository's tracked production module, one past the `v0.0.12` tag
so that it carries the interpreter-only build fix the tag itself lacks). This is
the same revision the backend's `formlogic/runtime` guest and the desktop's
`zipp-vm` dependency pin. All three must move together — an expression is
supposed to mean the same thing wherever it runs, and that only holds if they
share an engine.

The four files here are byte-identical to `landing/public/wasm/` in the zipp
repository at that revision; the module's SHA-256 is the one the zipp README
records as its tracked v0.0.12 artifact:

```text
raw         5,558,860 bytes
gzip-9      1,812,458 bytes
Brotli-11   1,248,649 bytes
SHA-256     bd8614fe5f3a3b8ef67f4b917cdefebb3fe69afa39a9804a0d3f6b0b6b267126
```

## Rebuilding

Exactly as `crates/zipp-wasm/README.md` in the zipp repo specifies. The steps are
not interchangeable with the obvious alternatives, and the zipp repo documents
why with measurements:

```sh
rustup +1.92.0 target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version '=0.2.126' --locked
cd crates/zipp-wasm
RUSTFLAGS='-Dwarnings -C link-arg=--max-memory=1073741824 -C link-arg=-zstack-size=1048576' \
  cargo +1.92.0 build --locked --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg \
  --remove-name-section --remove-producers-section \
  target/wasm32-unknown-unknown/release/zipp_wasm.wasm
node tests/node/strip-target-features.cjs \
  pkg/zipp_wasm_bg.wasm pkg/zipp_wasm_bg.stripped.wasm
mv pkg/zipp_wasm_bg.stripped.wasm pkg/zipp_wasm_bg.wasm
```

Then copy `zipp_wasm.js`, `zipp_wasm.d.ts`, `zipp_wasm_bg.wasm` and
`zipp_wasm_bg.wasm.d.ts` here.

The linked memory maximum is 1 GiB, deliberately ABOVE the VM's own 512 MiB
accounting limit: exhaustion then surfaces as a catchable `RangeError` inside
the engine instead of a linear-memory trap that kills the Worker. That maximum is
per instance; the host (`engine.ts`) is what bounds how many Workers exist.

**Do not add `wasm-opt`.** It is worse on both axes it appears to help: measured
on this module it is 22 KB *larger* after brotli (Binaryen's rewrites trade away
the regularity the compressor feeds on) and ~2% slower. The real saving comes
from dropping the name section, which `wasm-bindgen` already does.

**Do not set `opt-level = "z"`.** It cuts the wire size to ~975 KB but makes the
interpreter 1.9–2.5x slower.

## Size, and why it is worth watching

5.3 MB raw, ~1.2 MB brotli. That is meaningfully larger than the QuickJS build it
replaced (~0.79 MB raw, ~0.21 MB brotli), and it ships to every visitor who opens
a form with a calculated field.

Two things follow. First, it must be **served compressed** — the shipped
`.htaccess` asks Apache for Brotli/deflate on `application/wasm` and declares the
MIME type, and a deployment whose Apache lacks `mod_brotli`/`mod_deflate` (WAMP
ships them commented out) sends the full 5.3 MB. Second, the remaining weight is
engine breadth FormLogic does not use (full regex, Intl, unicode normalisation
tables); if it becomes a problem the lever is a narrower feature set in zipp, not
another build flag here.
