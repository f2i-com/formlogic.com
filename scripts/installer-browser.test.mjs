import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../formlogic/install.php', import.meta.url), 'utf8');
const postSource = source.slice(source.indexOf('async function post('), source.indexOf('function checkRequirements() {'));
function browser(fetch) {
  const messages = new Map();
  const notice = { textContent: '', classList: { remove() {} } };
  const context = vm.createContext({ fetch, URLSearchParams, AbortSignal, CSRF_TOKEN: 'test-token',
    sessionStorage: { setItem: (key, value) => messages.set(key, value) },
    document: { getElementById: () => notice },
  });
  vm.runInContext(postSource, context);
  return { context, messages, notice };
}

test('a Cloudflare HTML timeout is reported and retained without persisting submitted credentials', async () => {
  const b = browser(async () => new Response('<html>timeout</html>', { status: 524 }));
  await assert.rejects(vm.runInContext("post('run_install', {db_pass:'test-only-password'})", b.context), /HTTP 524/);
  assert.match(b.notice.textContent, /hosting PHP error log/);
  assert.match(b.messages.get('formlogic-install-error'), /HTTP 524/);
  assert.ok(!b.messages.get('formlogic-install-error').includes('test-only-password'));
});

test('server error references survive non-success HTTP statuses', async () => {
  const b = browser(async () => new Response(JSON.stringify({success:false,message:'Reference: install-test'}), { status: 500 }));
  await assert.rejects(vm.runInContext("post('run_install')", b.context), /install-test/);
  assert.equal(b.notice.textContent, 'Reference: install-test');
});

test('structured partial-install steps remain available to the progress UI', async () => {
  const b = browser(async () => new Response(JSON.stringify({success:false,message:'Database setup failed',steps:[{label:'Configuration',status:'ok'}]})));
  const result = await vm.runInContext("post('run_install')", b.context);
  assert.equal(result.steps[0].label, 'Configuration');
  assert.equal(result.success, false);
});

test('client timeout explains that the server may still be running', async () => {
  const b = browser(async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; });
  await assert.rejects(vm.runInContext("post('run_install')", b.context), /server may still be finishing/);
});
