import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from '../formlogic/ui/node_modules/typescript/lib/typescript.js';
import { frontendOrigin, sessionJsonHeaders } from './session-request.mjs';
import { createApiClient } from '../formlogic/tools/ai-app-builder/api-client.mjs';
import { request as playwrightRequest } from '../formlogic/ui/node_modules/playwright-core/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
const captures = [];
const touched = new Set(['scripts/session-request.mjs', 'scripts/session-request.d.mts', 'scripts/session-request.test.mjs', 'scripts/test-fixtures/session-origin-capture.php']);
const frontend = 'https://studio.fixture.invalid:8443/workspace/';
const origin = 'https://studio.fixture.invalid:8443';
const api = 'https://api.fixture.invalid';
const env = { E2E_BASE_URL: frontend, FORMLOGIC_REVIEW_PASSWORD: 'inert-public-fixture', E2E_EMAIL: 'fixture@example.invalid', E2E_PASSWORD: 'inert-public-fixture' };

function parsed(relative) {
  touched.add(relative);
  return ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, relative.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}
function collect(node, predicate) {
  const matches = [];
  function walk(n) { if (predicate(n)) matches.push(n); ts.forEachChild(n, walk); }
  walk(node); return matches;
}
function functionSource(relative, name) {
  const source = parsed(relative);
  const fn = collect(source, n => ts.isFunctionDeclaration(n) && n.name?.text === name)[0];
  assert.ok(fn, `${relative} exports ${name}`);
  return fn.getText(source).replace(/^export /, '');
}
function capture(source, url, options, expectedOrigin = origin) {
  const headers = Object.fromEntries(new Headers(options.headers));
  assert.equal(headers.origin, expectedOrigin, source);
  assert.equal(headers['content-type'], 'application/json', source);
  const body = options.body ?? JSON.stringify(options.data);
  assert.ok(body && typeof JSON.parse(body) === 'object', source);
  captures.push({ source, url: new URL(url, api).href, headers, body, expectedOrigin });
  return Promise.resolve({ ok: true, status: 201, headers: { getSetCookie: () => [] } });
}

test('frontend URL normalization and invalid configurations fail before transport', () => {
  assert.equal(frontendOrigin(frontend), origin);
  assert.equal(frontendOrigin('HTTPS://Studio.Fixture.Invalid:443/ui'), 'https://studio.fixture.invalid');
  assert.equal(frontendOrigin('http://[::1]:8080/ui'), 'http://[::1]:8080');
  for (const bad of ['', undefined, '/relative', 'null', 'file:///tmp/demo', 'https://user:pass@studio.invalid/']) {
    assert.throws(() => sessionJsonHeaders(bad));
  }
  assert.deepEqual(sessionJsonHeaders(frontend), { 'Content-Type': 'application/json', Origin: origin });
});

test('every operational Playwright session call executes its real options against an inert request capture', async () => {
  // An empty in-process context runs Playwright's real JSON/header serializer.
  // Replace the channel before any request: no request reaches its transport.
  const inertContext = await playwrightRequest.newContext();
  const originalChannel = inertContext._channel;
  let label = '';
  inertContext._channel = { fetch: async wire => {
    assert.equal(wire.method, 'POST');
    await capture(label, wire.url, { headers: Object.fromEntries(wire.headers.map(({ name, value }) => [name, value])), body: wire.jsonData });
    return { response: { url: wire.url, status: 204, statusText: 'Inert capture', headers: [], fetchUid: 'inert-no-transport' } };
  } };
  try {
  const helperSource = parsed('formlogic/ui/e2e/session-request.ts');
  const helperBody = helperSource.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(helperSource).replace(/^export /, '')).join('\n');
  const helper = vm.runInNewContext(`${helperBody}\n({sessionHeaders,E2E_FRONTEND_BASE_URL})`, { process: { env }, sessionJsonHeaders });
  assert.equal(helper.E2E_FRONTEND_BASE_URL, frontend);
  const config = read('formlogic/ui/playwright.config.ts'); touched.add('formlogic/ui/playwright.config.ts');
  assert.match(config, /baseURL: E2E_FRONTEND_BASE_URL/);
  let count = 0;
  for (const folder of ['formlogic/ui/e2e', 'formlogic/ui/scripts']) {
    for (const name of readdirSync(path.join(root, folder)).filter(n => /\.(?:spec\.ts|mjs)$/.test(n))) {
      const relative = `${folder}/${name}`;
      const source = parsed(relative);
      const calls = collect(source, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'post' && /\/(?:auth\/(?:login|register|mfa\/verify)|demo\/start)/.test(n.arguments[0]?.getText(source) ?? ''));
      if (!calls.length) { touched.delete(relative); continue; }
      for (const call of calls) {
        label = `${relative}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}`;
        const request = inertContext;
        const context = { request };
        const scope = { context, ctx: context, page: { context: () => context }, req: request, API: api, API_BASE: `${api}/api`, APP_BASE: frontend, origin: frontend, process: { env }, EMAIL: env.E2E_EMAIL, PASSWORD: env.E2E_PASSWORD, sessionHeaders: helper.sessionHeaders, sessionJsonHeaders };
        await vm.runInNewContext(call.getText(source), scope, { timeout: 1000 });
        count++;
      }
    }
  }
  assert.equal(count, 15, '12 E2E calls plus three capture/performance script calls');
  } finally {
    inertContext._channel = originalChannel;
    await inertContext.dispose();
  }
});

test('smoke-dist executes its actual registration/login options and cookie-jar serializer offline', async () => {
  const relative = 'scripts/smoke-dist.mjs';
  const source = parsed(relative);
  const requests = collect(source, n => ts.isCallExpression(n) && n.expression.getText(source) === 'req' && /\/api\/auth\/(?:login|register)/.test(n.arguments[0]?.getText(source) ?? ''));
  assert.equal(requests.length, 2);
  const jar = { cookie: 'fixture_session=inert; formlogic_csrf=inert-csrf' };
  const scope = vm.createContext({ BASE: origin, email: env.E2E_EMAIL, password: env.E2E_PASSWORD, jar, sessionJsonHeaders, fetch: (url, options) => { assert.equal(options.method, 'POST'); return capture(relative, url, options); }, Headers });
  vm.runInContext(functionSource(relative, 'req'), scope);
  for (const call of requests) await vm.runInContext(call.getText(source), scope);
  for (const request of captures.filter(c => c.source === relative)) assert.equal(request.headers.cookie, jar.cookie);
  assert.match(read(relative), /CORS_ORIGIN=\$\{BASE\}/, 'smoke frontend and server origin setting agree');
});

test('AI builder uses its injected frontend setting and preserves cookie/CSRF transport', async () => {
  touched.add('formlogic/tools/ai-app-builder/api-client.mjs'); touched.add('formlogic/tools/ai-app-builder/config.mjs'); touched.add('formlogic/tools/ai-app-builder/clients.mjs');
  const requests = [];
  const client = createApiClient({ frontendBase: frontend, apiBase: api, email: env.E2E_EMAIL, password: env.E2E_PASSWORD }, async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, 'POST');
    if (url.endsWith('/auth/login')) await capture('formlogic/tools/ai-app-builder/api-client.mjs', url, options);
    return new Response('{}', { status: 200, headers: [['Set-Cookie', 'formlogic_auth=inert-public-fixture; HttpOnly'], ['Set-Cookie', 'formlogic_csrf=inert-public-csrf']] });
  });
  await client.login();
  await client.request('POST', '/api/forms', { title: 'inert' });
  assert.equal(requests[1].options.headers.Cookie, 'formlogic_auth=inert-public-fixture; formlogic_csrf=inert-public-csrf');
  assert.equal(requests[1].options.headers['X-CSRF-Token'], 'inert-public-csrf');
  assert.equal(requests[1].options.headers.Origin, undefined, 'ordinary authenticated API calls retain their existing contract');
  let calls = 0;
  const invalid = createApiClient({ frontendBase: '', apiBase: api }, () => { calls++; });
  await assert.rejects(invalid.login()); assert.equal(calls, 0);
  assert.match(read('formlogic/tools/ai-app-builder/config.mjs'), /frontendBase: pick\('FL_FRONTEND_BASE', 'http:\/\/formlogic\.local'\)/);
  assert.match(read('formlogic/tools/ai-app-builder/clients.mjs'), /return createConfiguredApiClient\(config\)/);
});

test('the actual workflow seed shell serializes curl Origin and JSON using its frontend setting', () => {
  const relative = '.github/workflows/e2e.yml'; touched.add(relative);
  const workflow = read(relative);
  const seed = workflow.split('      - name: Seed the E2E test account\n        run: |\n')[1].split('\n      # Seed the marketplace')[0].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  assert.ok(seed.includes('status=$(curl'));
  const directory = mkdtempSync(path.join(tmpdir(), 'formlogic-session-capture-'));
  const captureScript = path.join(directory, 'capture.mjs');
  writeFileSync(captureScript, `import {writeFileSync} from 'node:fs'; const a=process.argv.slice(2); writeFileSync('argv.json',JSON.stringify(a)); writeFileSync(a[a.indexOf('-o')+1],'{}'); process.stdout.write('201');`);
  const shim = `node() { "${process.execPath.replaceAll('\\', '/')}" "${root.replaceAll('\\', '/')}/$1" "$2"; }\ncurl() { "${process.execPath.replaceAll('\\', '/')}" "${captureScript.replaceAll('\\', '/')}" "$@"; }\n`;
  const bash = process.env.FORMLOGIC_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
  execFileSync(bash, ['--noprofile', '--norc', '-c', shim + seed], { cwd: directory, env: { ...process.env, E2E_BASE_URL: frontend }, encoding: 'utf8' });
  const args = JSON.parse(readFileSync(path.join(directory, 'argv.json'), 'utf8'));
  assert.equal(args[args.indexOf('-X') + 1], 'POST');
  const headers = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '-H') { const [name, ...value] = args[++i].split(':'); headers[name] = value.join(':').trim(); }
  capture(relative, args[args.indexOf('-X') + 2], { headers, body: args[args.indexOf('-d') + 1] });
  assert.match(workflow, /CORS_ALLOWED_ORIGINS=\$\(node ..\/..\/scripts\/session-request\.mjs "\$E2E_BASE_URL"\)/);
});

test('captured callers reach real CSRF middleware only with the configured Origin and JSON', () => {
  // Exercise the shared options builder for the MFA route too; no operational Node MFA caller exists.
  for (const route of ['/api/auth/mfa/verify', '/api/auth/register', '/api/auth/login', '/api/demo/start']) {
    capture(`shared-options:${route}`, `${api}${route}`, { headers: sessionJsonHeaders(frontend), body: '{}' });
  }
  const php = process.env.FORMLOGIC_TEST_PHP || 'php';
  const result = spawnSync(php, ['-d', 'xdebug.mode=off', 'scripts/test-fixtures/session-origin-capture.php'], { cwd: root, input: JSON.stringify(captures), env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.failed, 0); assert.equal(receipt.checks, captures.length * 7);
  if (process.env.SESSION_CALLER_EVIDENCE) {
    const output = path.resolve(process.env.SESSION_CALLER_EVIDENCE); mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, 'captures.json'), JSON.stringify(captures, null, 2));
    writeFileSync(path.join(output, 'middleware.json'), JSON.stringify(receipt, null, 2));
    writeFileSync(path.join(output, 'bindings.json'), JSON.stringify([...touched].sort().map(source => ({ source, sha256: createHash('sha256').update(readFileSync(path.join(root, source))).digest('hex') })), null, 2));
    const dependencies = ['typescript/package.json', 'typescript/lib/typescript.js', 'playwright-core/package.json', 'playwright-core/index.mjs', 'playwright-core/lib/coreBundle.js'];
    writeFileSync(path.join(output, 'toolchain.json'), JSON.stringify({ node: process.version, typescript: JSON.parse(read('formlogic/ui/node_modules/typescript/package.json')).version, playwright: JSON.parse(read('formlogic/ui/node_modules/playwright-core/package.json')).version, dependencies: dependencies.map(dependency => ({ dependency, sha256: createHash('sha256').update(readFileSync(path.join(root, 'formlogic/ui/node_modules', dependency))).digest('hex') })) }, null, 2));
  }
});
