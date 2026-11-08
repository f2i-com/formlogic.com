// The app engine's brotli twin: dist/assets/zipp_wasm_bg-*.wasm.br beside each engine the build
// emitted (ZIPP's primary engine, 6.58 MB at ZIPP v0.0.33, about 1.65 MB as brotli, and its web
// variant). One file serves the whole site: the page downloads it once and gives it to the app
// frame and to Builder and Studio, so it is worth compressing once, at the best quality, here,
// rather than for every visitor at the lower quality a server can afford per request.
//
// The bundled .htaccess sends the twin to a browser that asks for brotli (browsers ask only over
// HTTPS); the README's nginx example does with ngx_brotli's brotli_static. Anything else is sent
// the engine itself, compressed on the fly where the server does that. Only the engines: every
// other file stays as it was, so the release grows by the twins alone.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

export const ENGINE_ASSET = /^zipp_wasm_bg-[^/]+\.wasm$/;

/** The brotli twin of `bytes`: the highest quality, the largest window, decoded once to prove it. */
export function brotliTwin(bytes) {
  const twin = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: constants.BROTLI_MAX_WINDOW_BITS,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
  if (!brotliDecompressSync(twin).equals(bytes)) throw new Error('The brotli twin does not decode to the engine it was made from.');
  return twin;
}

/** Writes a twin for every engine in `assets`; returns what was written. */
export function precompressEngines(assets) {
  const written = [];
  for (const name of readdirSync(assets).filter((file) => ENGINE_ASSET.test(file)).sort()) {
    const bytes = readFileSync(resolve(assets, name));
    const twin = brotliTwin(bytes);
    writeFileSync(resolve(assets, `${name}.br`), twin);
    written.push({ name, bytes: bytes.length, brotli: twin.length });
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = fileURLToPath(new URL('../dist/assets/', import.meta.url));
  const written = precompressEngines(assets);
  if (!written.length) throw new Error('formlogic/ui/dist/assets has no zipp_wasm_bg-*.wasm engine to compress; run vite build first.');
  for (const { name, bytes, brotli } of written) console.log(`precompress-engine: ${name} ${(bytes / 1048576).toFixed(2)} MB -> ${name}.br ${(brotli / 1048576).toFixed(2)} MB`);
}
