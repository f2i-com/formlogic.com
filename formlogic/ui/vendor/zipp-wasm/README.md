# ZIPP WebAssembly runtime

FormLogic vendors the official **ZIPP v0.0.17 web release**. The exact release,
source revision, archive digest and WASM digest are recorded in
[SOURCE.json](SOURCE.json). The JavaScript glue, type declarations and WASM file
must be updated together from that release archive.

## Runtime integration

Form expressions, calculated fields, validation and app logic run in a dedicated
worker. Each evaluation receives a fresh `Engine`, the canonical FormLogic
prelude and a JSON data context. The form-expression host does not install a
host bridge. Instruction budgets and the worker watchdog remain separate from
the engine download deadline.

The page's [byte broker](../../src/lib/formlogic/zipp-bytes.ts) downloads the
WASM lazily, checks its SHA-256 against SOURCE.json and caches one retryable
promise. It supplies cloned bytes to the form worker and any hosted Softn app.
On HTTP LAN development addresses without WebCrypto, verification lazily uses
FormLogic's existing bundled libsodium library instead of requiring HTTPS or
skipping the digest check.
Workers and hosted frames retain independent WebAssembly instances, memory and
capabilities. A worker restart or a second hosted app reuses the page's bytes;
it does not detach the shared buffer or download the engine again.

The trusted hosted shell advertises its engine version and hash before receiving
bytes. FormLogic rejects a mismatched shell with a visible update error. This
prevents new engine bytes being paired with old generated glue after a partial
site update. `npm run build:hosted-runtime` builds a matching shell and writes a
complete asset manifest; the normal frontend prebuild verifies that manifest.

Pages that do not request form evaluation or initialize a hosted app do not
fetch this binary. Each execution context still initializes its own module;
this integration shares the download, not mutable VM state or sandbox authority.

## Updating

1. Obtain `zipp-wasm-<version>-web.zip` from the corresponding official ZIPP
   release and verify its archive digest.
2. Replace `zipp_wasm.js`, `zipp_wasm.d.ts`, `zipp_wasm_bg.wasm` and
   `zipp_wasm_bg.wasm.d.ts` together. Refresh SOURCE.json with the release and
   computed binary digest; preserve the upstream license.
3. Update Softn's `packages/@softn/core/wasm-zipp` to the same release and digest.
4. Run `npm run build:hosted-runtime` from FormLogic's UI directory, followed by
   its build and runtime tests.
5. Check the [backend guest](../../../runtime/guest/Cargo.toml) and shared
   expression parity corpus as part of the same engine upgrade. The WASI guest
   is built separately; it is not this browser binary.

Useful checks from `formlogic/ui`:

```sh
npm test -- src/lib/formlogic/corpusParity.test.ts src/lib/formlogic/zipp-bytes.test.ts src/lib/formlogic/engine.test.ts src/components/studio/HostedAppFrame.test.tsx
npm run test:hosted-runtime
npm run test:zipp-sharing
```

Serve WASM as `application/wasm` with compression. FormLogic's `.htaccess`
provides the MIME and compression configuration, while the content-hashed URL
allows an updated artifact to coexist with an earlier cached version.
