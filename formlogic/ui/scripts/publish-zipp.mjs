// The site's ZIPP folder: dist/zipp/<the first 12 hex of the engine's sha256>/, the files of
// this build's ZIPP that the app frame and the editors load themselves when they run the site's
// own ZIPP (Softn v0.0.36 on; ready's `zippGlue: 1`, the editor bridge's `glue: 1`):
//
//   zipp_wasm.js     the glue (wasm-bindgen's bindings), the one script the frame's policy lets
//                    it import from outside its own folder, checked against SOURCE.json's
//                    glueSha256 there and here
//   zipp_torch.wasm  the torch package, built for this engine's ABI, for an app that declares torch
//   SOURCE.json      the record all three digests come from
//
// The engine itself is the page's hashed asset (assets/zipp_wasm_bg-*.wasm, with its brotli
// twin): the page downloads it once and gives it to the frame and the editors. The folder is
// named by the engine it goes with, so a new ZIPP is a new folder and every file in one can be
// kept for good (public/zipp/.htaccess). Each file is held to its digest before it is written.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The folder a ZIPP's files are published in, named by its engine. */
export function zippFolderName(source) {
  if (!/^[0-9a-f]{64}$/.test(source?.sha256 ?? '')) throw new Error('SOURCE.json records no engine sha256');
  return source.sha256.slice(0, 12);
}

/**
 * Publishes `ui`'s installed ZIPP into `ui/dist/zipp/<name>/`, and nothing else there: a folder
 * an earlier build left is removed. Returns the folder name and the files written.
 */
export function publishZipp(ui) {
  const vendor = resolve(ui, 'vendor/zipp-wasm');
  const source = JSON.parse(readFileSync(resolve(vendor, 'SOURCE.json'), 'utf8'));
  const name = zippFolderName(source);
  const files = [
    { as: 'zipp_wasm.js', from: resolve(vendor, 'zipp_wasm.js'), sha256: source.glueSha256, what: 'the glue' },
    { as: 'SOURCE.json', from: resolve(vendor, 'SOURCE.json') },
  ];
  const torch = source.packages?.torch;
  if (torch) {
    // The release's torch tree where it is installed, else the hosted runtime's copy, which the
    // Softn release installer has already held to the same digest.
    const tree = resolve(ui, 'vendor/zipp-wasm-torch/zipp_torch.wasm');
    files.push({ as: 'zipp_torch.wasm', from: existsSync(tree) ? tree : resolve(ui, 'public/hosted-runtime/assets/core-runtime/zipp_torch.wasm'), sha256: torch.sha256, what: 'the torch package' });
  }
  for (const file of files) {
    if (!existsSync(file.from)) throw new Error(`${file.from} is missing: ${file.what ?? file.as} of ZIPP ${source.release ?? source.version}. Run node scripts/fetch-softn-release.mjs.`);
    if (file.sha256 && sha256(readFileSync(file.from)) !== file.sha256) throw new Error(`${file.from} is not ${file.what} SOURCE.json records (${file.sha256.slice(0, 12)})`);
  }
  const root = resolve(ui, 'dist/zipp');
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && entry.name !== name) rmSync(resolve(root, entry.name), { recursive: true, force: true });
  const folder = resolve(root, name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder);
  for (const file of files) copyFileSync(file.from, resolve(folder, file.as));
  return { name, files: files.map((file) => file.as) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { name, files } = publishZipp(fileURLToPath(new URL('../', import.meta.url)));
  console.log(`publish-zipp: dist/zipp/${name}/ ${files.join(', ')}`);
}
