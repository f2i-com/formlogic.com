import {Worker} from 'node:worker_threads';
import {readFileSync,writeFileSync,writeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';

// FormLogic supervisor for shared-database native apps and container record-event capture.
// Loads the trusted SoftN runtime modules from SOFTN_RUNTIME_DIR while keeping the
// worker isolated with a hard wall-clock deadline and memory limit.
const runtimeDir = process.env.SOFTN_RUNTIME_DIR || '';
if (!runtimeDir) {
  process.stderr.write('softn: startup stage configuration_read: missing runtime directory\n');
  process.exit(1);
}

const {setupDeadlineMs} = await import(pathToFileURL(join(runtimeDir, 'migrations.mjs')).href);

let input = '';
let bytes = 0;
process.stdin.setEncoding('utf8');
const shortened = Number(process.env.SOFTN_RUNNER_DEADLINE_MS);
const DEADLINE_MS =
  setupDeadlineMs(process.env) ??
  (Number.isInteger(shortened) && shortened >= 1 && shortened <= 20_000 ? shortened : 20_000);

let migration = null;

function stopped(m) {
  try {
    let stops = 1;
    try {
      const was = JSON.parse(readFileSync(m.marker, 'utf8'));
      if (was.name === m.name && was.sha256 === m.sha256) stops = (Number(was.stops) || 0) + 1;
    } catch {}
    writeFileSync(m.marker, JSON.stringify({name: m.name, sha256: m.sha256, stops}), {mode: 0o600});
    writeSync(
      2,
      `softn: startup stage database_migrations: migration ${m.file} was stopped at the ${DEADLINE_MS / 1000} s deadline (${stops} of ${m.attempts})\n`
    );
  } catch {}
}

const deadline = setTimeout(() => {
  if (migration) stopped(migration);
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {
    process.exit(1);
  }
}, DEADLINE_MS);

try {
  for await (const chunk of process.stdin) {
    input += chunk;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8_000_000) throw new Error('Input limit');
  }
  const worker = new Worker(new URL('./shared-native-worker.mjs', import.meta.url), {
    workerData: input,
    resourceLimits: {maxOldGenerationSizeMb: 128},
  });
  worker.on('message', m => {
    if (m && typeof m === 'object' && Object.hasOwn(m, 'migration')) migration = m.migration;
  });
  worker.once('error', e => {
    try {
      process.stderr.write('softn: runner worker died: ' + String(e?.code || e?.name || 'error') + '\n');
    } catch {}
    process.exit(1);
  });
  worker.once('exit', code => {
    clearTimeout(deadline);
    process.exitCode = code;
  });
} catch {
  clearTimeout(deadline);
  process.exitCode = 1;
}
