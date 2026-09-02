# zipp-wasm (vendored)

The browser half of FormLogic's expression sandbox. Author-written conditions,
calculated fields, validation rules and app-logic hooks run in this engine, in a
dedicated Web Worker, with an empty global object and no host bridge installed.

**Built from** `f2i-com/zipp.org` at **`024c1149`** (v0.0.12 plus
`setInstructionBudget`, the host-side knob that lets this module run the same
200M-step budget the backend guest uses — without it a heavy expression could
succeed at submit and yet come back `null` here). This is the same revision the
backend's `formlogic/runtime` guest pins. Both must move together — an
expression is supposed to mean the same thing wherever it runs, and that only
holds if they share an engine.

Built with the recipe below (not a copy of zipp's tracked landing module, which
predates the budget API):

```text
raw         5,559,686 bytes
gzip-9      1,841,812 bytes
Brotli-11   1,250,755 bytes
SHA-256     e735b8a787c2cd50d948d65d5ee51c343eccef9a8c45399fdc212cfe2569e31d
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
