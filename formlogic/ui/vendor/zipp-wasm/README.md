# zipp-wasm (vendored)

The browser half of FormLogic's expression sandbox. Author-written conditions,
calculated fields, validation rules and app-logic hooks run in this engine, in a
dedicated Web Worker, with an empty global object and no host bridge installed.

**Built from** `f2i-com/zipp.org` at **`ddbf7cd9`** (v0.0.10), which is the same
revision the backend's `formlogic/runtime` crate and the desktop's `zipp-vm`
dependency pin. All three must move together — an expression is supposed to mean
the same thing wherever it runs, and that only holds if they share an engine.

## Rebuilding

Exactly as `crates/zipp-wasm/README.md` in the zipp repo specifies. The steps are
not interchangeable with the obvious alternatives, and the zipp repo documents
why with measurements:

```sh
rustup +1.92.0 target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version '=0.2.126' --locked
cd crates/zipp-wasm
RUSTFLAGS='-Dwarnings -C link-arg=--max-memory=268435456 -C link-arg=-zstack-size=1048576' \
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

**Do not add `wasm-opt`.** It is worse on both axes it appears to help: measured
on this module it is 22 KB *larger* after brotli (Binaryen's rewrites trade away
the regularity the compressor feeds on) and ~2% slower. The real saving comes
from dropping the name section, which `wasm-bindgen` already does.

**Do not set `opt-level = "z"`.** It cuts the wire size to ~975 KB but makes the
interpreter 1.9–2.5x slower.

## Size, and why it is worth watching

5.2 MB raw, ~1.2 MB brotli. That is meaningfully larger than the QuickJS build it
replaced (~0.79 MB raw, ~0.21 MB brotli), and it ships to every visitor who opens
a form with a calculated field.

Two things follow. First, **serve this compressed** — at the time of writing the
deployment sends no `Content-Encoding` at all, which turns a 1.2 MB download into
a 5.2 MB one. Second, the remaining weight is engine breadth FormLogic does not
use (full regex, Intl, unicode normalisation tables); if it becomes a problem the
lever is a narrower feature set in zipp, not another build flag here.
