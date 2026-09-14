#!/usr/bin/env node
// Ecosystem compatibility manifest (ecosystem review ECO-02, 14 September 2026).
//
// FormLogic is the hub of the tested set: it pins a Softn revision (the hosted
// runtime and native backend), that Softn revision pins an XDB revision, and
// both FormLogic and Softn vendor the same ZIPP release. Those pins already
// exist and are authoritative; this script does NOT add competing constants.
// It READS them, verifies they agree with the artifacts actually present, and
// writes one machine-readable manifest that names every revision, digest,
// protocol version and schema range a release was tested with.
//
//   node scripts/ecosystem-manifest.mjs                # write docs/ecosystem/compatibility-manifest.json
//   node scripts/ecosystem-manifest.mjs --check        # verify the committed manifest matches the tree
//   SOFTN_REPO=/path/to/softn.com node scripts/ecosystem-manifest.mjs
//
// Sources (all existing controls):
//   .github/actions/prepare-hosted-runtime/action.yml        FormLogic -> Softn revision
//   <softn>/.github/scripts/checkout-xdb.sh                   Softn -> XDB revision
//   formlogic/ui/vendor/zipp-wasm/SOURCE.json                 FormLogic's vendored ZIPP release + digest
//   <softn>/packages/@softn/core/wasm-zipp/SOURCE.json        Softn's vendored ZIPP release + digest
//   <softn>/apps/softn-host-php/runtime/host-protocol.json         native hosting protocol versions
//   formlogic/backend/resources/softn-native/provenance.json  what the prepared native runtime carries
//   formlogic/ui/src/lib/softn/provenance.json                 the vendored FormLogic adapter's source digest
//   formlogic/ui/src/lib/softn/protocol.json                   the protocol versions FormLogic speaks
//   formlogic/backend/src/Services/AccountBackupService.php   account backup format versions
//   formlogic/backend/src/Database/SQLiteConnection.php       per-form SQLite schema version
//   <softn> apps/softn-loader/src-tauri/Cargo.toml            the loader's XDB path dependency
//
// A manifest is evidence about SOURCE revisions and the digests of the files
// present in the tree. It is not verification of bytes downloaded elsewhere:
// release.yml / package.yml must recompute digests of the artifacts they ship.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_PROTOCOL, RECORD_EVENTS_PROTOCOL, EDITOR_BRIDGE_PROTOCOL } from '../formlogic/ui/scripts/softn-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const softnRepo = resolve(process.env.SOFTN_REPO ?? resolve(root, '..', 'softn.com'));
const xdbRepo = process.env.XDB_REPO ? resolve(process.env.XDB_REPO) : resolve(root, '..', 'xdb.org');
const check = process.argv.includes('--check');
const out = resolve(root, 'docs', 'ecosystem', 'compatibility-manifest.json');

const problems = [];
const read = (path) => readFileSync(path, 'utf8');
const json = (path) => JSON.parse(read(path));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
// Text vendored from Softn is hashed with LF line endings on both sides, so a
// CRLF checkout (core.autocrlf on Windows) and a LF checkout (CI) agree.
const sha256Text = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const must = (condition, message) => { if (!condition) problems.push(message); };
const gitHead = (repo) => {
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
};

// ── FormLogic -> Softn ───────────────────────────────────────────────────────
const action = read(resolve(root, '.github/actions/prepare-hosted-runtime/action.yml'));
const softnPin = /repository:\s*f2i-com\/softn\.com\s*\n\s*ref:\s*([0-9a-f]{40})/.exec(action)?.[1];
must(softnPin, 'prepare-hosted-runtime/action.yml does not pin a 40-hex Softn revision');

// ── Softn -> XDB ─────────────────────────────────────────────────────────────
let xdbPin = null;
let softnHead = null;
let softnProtocol = null;
let softnZipp = null;
let loaderXdbDependency = null;
if (existsSync(softnRepo)) {
  softnHead = gitHead(softnRepo);
  const checkout = read(resolve(softnRepo, '.github/scripts/checkout-xdb.sh'));
  xdbPin = /XDB_COMMIT="([0-9a-f]{40})"/.exec(checkout)?.[1] ?? null;
  must(xdbPin, 'softn checkout-xdb.sh does not pin a 40-hex XDB revision');
  softnProtocol = json(resolve(softnRepo, 'apps/softn-host-php/runtime/host-protocol.json'));
  softnZipp = json(resolve(softnRepo, 'packages/@softn/core/wasm-zipp/SOURCE.json'));
  const loaderCargo = read(resolve(softnRepo, 'apps/softn-loader/src-tauri/Cargo.toml'));
  loaderXdbDependency = /^xdb\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/m.exec(loaderCargo)?.[1] ?? null;
  if (softnHead && softnPin && softnHead !== softnPin) {
    problems.push(`the Softn checkout at ${softnRepo} is ${softnHead}, but FormLogic pins ${softnPin}; run against the pinned revision`);
  }
} else {
  problems.push(`Softn checkout not found at ${softnRepo} (set SOFTN_REPO)`);
}
let xdbHead = null;
if (existsSync(xdbRepo)) {
  xdbHead = gitHead(xdbRepo);
  if (xdbHead && xdbPin && xdbHead !== xdbPin) problems.push(`the XDB checkout at ${xdbRepo} is ${xdbHead}, but Softn pins ${xdbPin}`);
}

// ── ZIPP: one release, identical bytes, in both trees and in the prepared runtime ──
const flZipp = json(resolve(root, 'formlogic/ui/vendor/zipp-wasm/SOURCE.json'));
const flZippDigest = sha256(resolve(root, 'formlogic/ui/vendor/zipp-wasm/zipp_wasm_bg.wasm'));
must(flZippDigest === flZipp.sha256, `FormLogic vendored ZIPP bytes (${flZippDigest}) differ from SOURCE.json (${flZipp.sha256})`);
if (softnZipp) {
  must(softnZipp.version === flZipp.version && softnZipp.sha256 === flZipp.sha256 && softnZipp.revision === flZipp.revision,
    `Softn vendors ZIPP ${softnZipp.version}@${softnZipp.revision} (${softnZipp.sha256}) but FormLogic vendors ${flZipp.version}@${flZipp.revision} (${flZipp.sha256})`);
  const softnDigest = sha256(resolve(softnRepo, 'packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm'));
  must(softnDigest === softnZipp.sha256, `Softn vendored ZIPP bytes (${softnDigest}) differ from its SOURCE.json (${softnZipp.sha256})`);
}
const runtimeProvenancePath = resolve(root, 'formlogic/backend/resources/softn-native/provenance.json');
let runtimeProvenance = null;
if (existsSync(runtimeProvenancePath)) {
  runtimeProvenance = json(runtimeProvenancePath);
  must(runtimeProvenance.zipp?.sha256 === flZipp.sha256, 'the prepared native runtime carries a different ZIPP digest than FormLogic vendors');
  must(runtimeProvenance.nativeProtocol === NATIVE_PROTOCOL, `the prepared native runtime is not native hosting protocol ${NATIVE_PROTOCOL}`);
  const runtimeWasm = resolve(root, 'formlogic/backend/resources/softn-native/wasm/zipp_wasm_bg.wasm');
  if (existsSync(runtimeWasm)) must(sha256(runtimeWasm) === flZipp.sha256, 'the prepared native runtime wasm bytes differ from FormLogic\'s vendored release');
}
if (softnProtocol) {
  must(softnProtocol.nativeProtocol === NATIVE_PROTOCOL, `Softn's runtime speaks native protocol ${softnProtocol.nativeProtocol}; FormLogic requires ${NATIVE_PROTOCOL}`);
  must(softnProtocol.recordEvents === RECORD_EVENTS_PROTOCOL, `Softn's runtime record-event protocol is ${softnProtocol.recordEvents}; FormLogic requires ${RECORD_EVENTS_PROTOCOL}`);
}

// ── Vendored FormLogic adapter (formlogic/ui/src/lib/softn/project.ts) ──────
// The only Softn copy that is not a build output: sync-softn.mjs writes it and
// records the source digest in provenance.json. Both halves are checked: the
// copy in the tree is what provenance describes (not hand-edited), and
// provenance describes the Softn source at the pinned revision (not stale).
const adapterDir = resolve(root, 'formlogic/ui/src/lib/softn');
const adapterProvenance = json(resolve(adapterDir, 'provenance.json'));
const vendoredAdapter = read(resolve(adapterDir, 'project.ts'));
const vendoredBody = vendoredAdapter.slice(vendoredAdapter.indexOf('\n') + 1); // after the one-line provenance header
must(/^[0-9a-f]{64}$/.test(adapterProvenance.sha256 ?? ''), 'formlogic/ui/src/lib/softn/provenance.json has no sha256');
must(sha256Text(vendoredBody) === adapterProvenance.sha256, 'the vendored Softn adapter project.ts does not match its provenance.json; run node formlogic/ui/scripts/sync-softn.mjs rather than editing the copy');
if (existsSync(softnRepo)) {
  const adapterSource = resolve(softnRepo, 'packages/@softn/core/src/integrations/formlogic.ts');
  if (existsSync(adapterSource)) {
    const sourceDigest = sha256Text(read(adapterSource));
    must(sourceDigest === adapterProvenance.sha256, `the vendored FormLogic adapter is stale: provenance.json records ${adapterProvenance.sha256.slice(0, 12)} but Softn's integrations/formlogic.ts at the pinned revision is ${sourceDigest.slice(0, 12)}; run node formlogic/ui/scripts/sync-softn.mjs against the pinned checkout and commit the result`);
  } else {
    problems.push('Softn checkout has no packages/@softn/core/src/integrations/formlogic.ts (the vendored adapter\'s source); update sync-softn.mjs if it moved');
  }
}

// ── FormLogic data formats ───────────────────────────────────────────────────
const backupService = read(resolve(root, 'formlogic/backend/src/Services/AccountBackupService.php'));
const backupFormat = Number(/public const FORMAT_VERSION = (\d+);/.exec(backupService)?.[1]);
const backupSupported = (/SUPPORTED_FORMAT_VERSIONS = \[([^\]]+)\]/.exec(backupService)?.[1] ?? '').split(',').map(s => Number(s.trim())).filter(Number.isFinite);
const sqliteConnection = read(resolve(root, 'formlogic/backend/src/Database/SQLiteConnection.php'));
const formSchema = Number(/private const SCHEMA_VERSION = (\d+);/.exec(sqliteConnection)?.[1]);
must(Number.isFinite(backupFormat) && backupSupported.includes(backupFormat), 'AccountBackupService format versions are unreadable');
must(Number.isFinite(formSchema), 'SQLiteConnection schema version is unreadable');

// ── Aokie connector contract (copied into FormLogic) ─────────────────────────
let aokieContract = null;
for (const candidate of ['formlogic/backend/resources/contracts/aokie-connector-contract.v1.json', 'docs/contracts/aokie-connector-contract.v1.json']) {
  const path = resolve(root, candidate);
  if (existsSync(path)) { aokieContract = { path: candidate, contractVersion: json(path).contractVersion, sha256: sha256(path) }; break; }
}

const manifest = {
  kind: 'formlogic.ecosystemCompatibilityManifest',
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  note: 'Source revisions and digests of files present in the tree at generation time. Release workflows must recompute digests of the artifacts they actually ship; provenance is not verification of downloaded bytes.',
  components: {
    formlogic: { revision: gitHead(root), backupFormat: { current: backupFormat, importable: backupSupported }, formSqliteSchema: formSchema },
    softn: { pinnedBy: 'formlogic/.github/actions/prepare-hosted-runtime/action.yml', revision: softnPin, checkoutRevision: softnHead, nativeProtocol: softnProtocol?.nativeProtocol ?? null, recordEvents: softnProtocol?.recordEvents ?? null, minimumNode: softnProtocol?.minimumNode ?? null, formlogicAdapter: { vendoredAt: 'formlogic/ui/src/lib/softn/project.ts', source: adapterProvenance.source ?? null, sha256: adapterProvenance.sha256 ?? null } },
    xdb: { pinnedBy: 'softn/.github/scripts/checkout-xdb.sh', revision: xdbPin, checkoutRevision: xdbHead, consumedAs: loaderXdbDependency, note: 'Native peer networking is opt-in and local-only by default at this revision; see xdb docs/networking-and-restore-policy.md' },
    zipp: { pinnedBy: 'formlogic/ui/vendor/zipp-wasm/SOURCE.json and softn packages/@softn/core/wasm-zipp/SOURCE.json', version: flZipp.version, revision: flZipp.revision, variant: flZipp.variant, languages: flZipp.languages, artifact: flZipp.artifact, sha256: flZipp.sha256, rustc: flZipp.rustc, wasmBindgen: flZipp.wasmBindgen },
    aokie: aokieContract ?? { note: 'connector contract copy not present in this tree' },
  },
  nativeRuntime: runtimeProvenance ? { nativeProtocol: runtimeProvenance.nativeProtocol, zipp: runtimeProvenance.zipp, modules: runtimeProvenance.modules } : { note: 'run scripts/prepare-native-runtime.mjs to record the prepared runtime' },
  compatibility: {
    hostedRuntimeProtocol: NATIVE_PROTOCOL,
    nativeHostingProtocol: NATIVE_PROTOCOL,
    recordEventsProtocol: RECORD_EVENTS_PROTOCOL,
    editorBridgeProtocol: EDITOR_BRIDGE_PROTOCOL,
    accountBackupFormats: backupSupported,
    formSqliteSchema: formSchema,
    migrationDirection: 'forward only: newer FormLogic imports older backup formats; older FormLogic refuses newer ones',
  },
  problems,
};

const rendered = JSON.stringify(manifest, null, 2) + '\n';
if (check) {
  if (!existsSync(out)) { console.error(`missing ${out}; run without --check to generate it`); process.exit(1); }
  const committed = JSON.parse(read(out));
  const strip = (m) => { const { generatedAt, components, problems: p, ...rest } = m; const c = JSON.parse(JSON.stringify(components)); if (c.formlogic) delete c.formlogic.revision; if (c.softn) delete c.softn.checkoutRevision; if (c.xdb) delete c.xdb.checkoutRevision; return { ...rest, components: c }; };
  const same = JSON.stringify(strip(committed)) === JSON.stringify(strip(manifest));
  // Problems first: a stale manifest is usually a symptom of one of them.
  if (problems.length) {
    console.error('compatibility problems:');
    for (const p of problems) console.error(' - ' + p);
  }
  if (!same) console.error('compatibility-manifest.json is stale: regenerate it with `node scripts/ecosystem-manifest.mjs` and commit the result');
  if (!same || problems.length) process.exit(1);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rendered);
  console.log(`wrote ${out}`);
  if (problems.length) {
    console.error('compatibility problems:');
    for (const p of problems) console.error(' - ' + p);
    process.exit(1);
  }
}
console.log(`ecosystem set: formlogic ${manifest.components.formlogic.revision?.slice(0, 12)} -> softn ${softnPin?.slice(0, 12)} -> xdb ${xdbPin?.slice(0, 12)}; zipp ${flZipp.version}@${flZipp.revision.slice(0, 12)} (${flZipp.sha256.slice(0, 12)})`);
