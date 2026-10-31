/** Exercise only the CLI installer's actual Node guard; never source or run the installer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'formlogic/install.sh'), 'utf8').replace(/\r\n/g, '\n');
const guard = source.match(/^NODE_VERSION=\$\(node -v\)\n[\s\S]*?(?=^ok "All prerequisites)/m)?.[0];
assert.ok(guard, 'The installer Node guard must be extracted before any setup commands.');
const gitBash = process.platform === 'win32'
  ? resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() || '.', '../../../bin/bash.exe') : null;
const bash = gitBash && existsSync(gitBash) ? gitBash : 'bash';
const php = process.env.FORMLOGIC_TEST_PHP || 'php';

function check(version) {
  const script = `set -euo pipefail
node() { printf '%s\\n' "$TEST_NODE_VERSION"; }
php() { command "$TEST_PHP_BIN" -n "$@"; }
error() { printf '%s\\n' "$1" >&2; }
${guard}
printf 'NODE-GUARD-PASSED\\n'
`;
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TEST_NODE_VERSION: version, TEST_PHP_BIN: php.replaceAll('\\', '/'), SCRIPT_DIR: resolve(root, 'formlogic').replaceAll('\\', '/') },
  });
  assert.ifError(result.error);
  return result;
}

test('CLI source install rejects Node versions outside the exact UI engine range before setup', () => {
  for (const version of ['v20.19.0', 'v22.12.0', 'v22.22.1', 'v23.0.0', 'v24.14.99', 'v25.0.0', '', 'not-node', 'v24.19.0-rc.1']) {
    const result = check(version);
    assert.equal(result.status, 1, `${version}: ${result.stderr}`);
    assert.match(result.stderr, /22\.22\.2\+ \(22\.x\), 24\.15\.0\+ \(24\.x\), or 26\+/);
    assert.ok(!result.stdout.includes('NODE-GUARD-PASSED'), version);
  }
});

test('CLI source install accepts supported versions using the same PHP guard as the wizard', () => {
  for (const version of ['v22.22.2', 'v22.23.0', 'v24.15.0', 'v24.19.0', 'v26.0.0', 'v27.0.0']) {
    const result = check(version);
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.equal(result.stdout, 'NODE-GUARD-PASSED\n');
    assert.equal(result.stderr, '');
  }
});

test('CLI frontend setup uses the committed lockfile and prepares hosted/native storage', () => {
  assert.ok(existsSync(resolve(root, 'formlogic/ui/package-lock.json')));
  assert.match(source, /^npm ci$/m);
  assert.doesNotMatch(source, /^npm install(?: |$)/m);
  const directories = source.match(/^mkdir -p (storage\/forms .*)$/m)?.[1].split(' ');
  assert.ok(directories?.includes('storage/native-apps'));
  assert.ok(directories?.includes('storage/hosted-apps'));
  assert.ok(directories?.includes('storage/pack-screenshots'));
});

test('the wizard, INSTALL.txt and the deployment guide list the same scheduled jobs', () => {
  const jobs = (file) => [...new Set(readFileSync(resolve(root, file), 'utf8').match(/^.*\bbin\/[a-z-]+\.php.*$/gm)
    .filter((line) => /(?:\*|[\d/-]+)(?: (?:\*|\d+)){4}\s+php\b/.test(line))
    .map((line) => line.match(/bin\/([a-z-]+)\.php/)[1]))].sort();
  const expected = [
    'artifact-sweep', 'backup-accounts', 'desktop-commands-cleanup', 'flow-outcome-dispatch', 'flow-runs-reclaim',
    'idempotency-cleanup', 'native-record-dispatch', 'privacy-sweep', 'reconcile', 'webhook-worker',
  ];
  for (const file of ['formlogic/install.php', 'scripts/package-dist.mjs']) assert.deepEqual(jobs(file), expected, file);
  const guide = readFileSync(resolve(root, 'DEPLOYMENT.md'), 'utf8');
  const listed = guide.slice(guide.indexOf('### Every scheduled job'), guide.indexOf('## 4. PayPal'));
  for (const job of expected) assert.ok(listed.includes(`bin/${job}.php`), job);
});
