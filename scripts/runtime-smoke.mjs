#!/usr/bin/env node
// The sandbox launcher smoke test: one eval job through a launcher and the
// backend prelude, the same calculated field scripts/smoke-dist.mjs submits
// through the whole app. A launcher that starts but cannot load the standard
// library, or evaluates wrongly, fails here as surely as one that cannot start.
//
//   node scripts/runtime-smoke.mjs <launcher>                      run it here
//   node scripts/runtime-smoke.mjs <launcher> --docker <image>     run a Linux launcher in a container (from Windows)
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRELUDE = resolve(root, 'formlogic/backend/resources/formlogic-prelude.js');
export const SMOKE_JOB = { mode: 'eval', jobs: [{ id: 'smoke', expression: 'validators.email("smoke@example.com") ? 40 + 2 : -1' }], context: {} };
export const SMOKE_VALUE = 42;

/** The smoke job's value from a launcher's stdout, or an error saying what came back instead. */
export function smokeValue(stdout) {
  const frames = String(stdout).split('\n').filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } });
  const done = frames.find((frame) => frame?.type === 'done');
  if (!done) throw new Error(`no done frame (stdout: ${String(stdout).trim().slice(0, 300) || '(empty)'})`);
  const result = done.results?.find((entry) => entry.id === 'smoke');
  if (!result?.ok) throw new Error(`the job failed: ${JSON.stringify(result ?? done).slice(0, 300)}`);
  return result.value;
}

export function smoke(launcher, { docker = null } = {}) {
  const input = JSON.stringify(SMOKE_JOB) + '\n';
  const [command, args] = docker
    ? ['docker', ['run', '--rm', '-i', '-v', `${dirname(resolve(launcher))}:/sandbox/bin:ro`, '-v', `${dirname(PRELUDE)}:/sandbox/resources:ro`, docker, `/sandbox/bin/${basename(launcher)}`, '--prelude', '/sandbox/resources/formlogic-prelude.js']]
    : [resolve(launcher), ['--prelude', PRELUDE]];
  const run = spawnSync(command, args, { input, encoding: 'utf8', timeout: 120_000 });
  if (run.error) throw new Error(`${basename(launcher)} did not start: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${basename(launcher)} exited ${run.status}: ${String(run.stderr).trim().slice(0, 300)}`);
  const value = smokeValue(run.stdout);
  if (value !== SMOKE_VALUE) throw new Error(`${basename(launcher)} evaluated the smoke job to ${JSON.stringify(value)}, not ${SMOKE_VALUE}`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [launcher, ...rest] = process.argv.slice(2);
  const dockerIndex = rest.indexOf('--docker');
  if (!launcher) { console.error('usage: node scripts/runtime-smoke.mjs <launcher> [--docker <image>]'); process.exit(2); }
  try {
    smoke(launcher, { docker: dockerIndex >= 0 ? rest[dockerIndex + 1] : null });
    console.log(`smoke: ${basename(launcher)} evaluated the prelude-backed calculated field to ${SMOKE_VALUE}${dockerIndex >= 0 ? ` (in ${rest[dockerIndex + 1]})` : ''}`);
  } catch (error) {
    console.error(`smoke: ${error.message}`);
    process.exit(1);
  }
}
