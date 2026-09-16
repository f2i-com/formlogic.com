// A production-bundle browser check, with no account or external API calls.
// Build the hosted runtime first: npm run build:hosted-runtime
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'e2e/fixtures/zipp-sharing.html');
const hostedRoot = join(root, 'public/hosted-runtime');
await import('./check-hosted-runtime.mjs');
const output = await mkdtemp(join(tmpdir(), 'formlogic-zipp-sharing-'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
let browser;
let server;
try {
  await build({
    root, configFile: false, publicDir: false, plugins: [react()],
    build: { outDir: output, emptyOutDir: true, rolldownOptions: { input: fixture } },
  });
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (/^\/api\/app\/sharing-test-\d+\/actions\/echo$/.test(path) && request.method === 'POST') {
      let input = '';
      for await (const chunk of request) input += chunk;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ result: { message: JSON.parse(input).message } }));
      return;
    }
    const isHosted = path.startsWith('/hosted-runtime/');
    const directory = isHosted ? hostedRoot : output;
    const relative = isHosted ? path.slice('/hosted-runtime/'.length) : path.slice(1);
    const file = resolve(directory, relative || 'e2e/fixtures/zipp-sharing.html');
    if (!file.startsWith(resolve(directory) + sep)) { response.writeHead(403).end(); return; }
    try {
      response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  for (const order of ['expression-first', 'app-first', 'concurrent', 'without-webcrypto', 'download-retry', 'stale-host', 'self-navigation', 'frame-policy', 'host-js-frame', 'python-app']) {
    // Fresh context + fixture without PWA registration avoids cached engines.
    // Playwright's serviceWorkers:block init script itself throws when reading
    // navigator.serviceWorker inside this deliberately opaque sandboxed iframe.
    const context = await browser.newContext();
    if (order === 'without-webcrypto') {
      await context.addInitScript(() => {
        if (window === top) Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined });
      });
    }
    const page = await context.newPage();
    const wasmRequests = [];
    const errors = [];
    let failedDownload = false;
    page.on('pageerror', error => errors.push(error.message));
    context.on('request', request => {
      if (/zipp[^/]*\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url());
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'The fixture must not contact an external service');
      if (order === 'download-retry' && !failedDownload && /zipp[^/]*\.wasm$/.test(url.pathname)) {
        failedDownload = true;
        return route.fulfill({ status: 503, body: 'Temporary test failure' });
      }
      if (order === 'stale-host' && url.pathname === '/hosted-runtime/index.html') {
        return route.fulfill({ contentType: 'text/html', body: `<script>parent.postMessage({type:'formlogic:ready',zipp:{version:'0.0.1',sha256:'old'}},'*')</script>` });
      }
      // A frame that replaces its own document. sandbox=allow-scripts permits this and the parent
      // cannot prevent it, so the check is that the parent notices: no archive is involved.
      if (order === 'self-navigation' && url.pathname === '/hosted-runtime/index.html') {
        return route.fulfill({ contentType: 'text/html', body: `<script>if (!location.search) setTimeout(() => { location.search = '?elsewhere'; }, 50)</script>` });
      }
      return route.continue();
    });
    // What each runtime document actually WRITES over itself, read out of a real browser rather
    // than guessed at from a bundle. The two documents share one entry chunk, in which the
    // 'unsafe-eval' token is a conditional, so a grep over that chunk finds it for BOTH and proves
    // nothing; only the running document can say which policy it took. index.html's policy is the
    // one every hosted app has always run under, and host.html's must differ by exactly the one
    // token, in exactly the one directive, that makes host JavaScript possible at all.
    if (order === 'frame-policy') {
      const policyOf = async (document) => {
        await page.goto(`${origin}/hosted-runtime/${document}`);
        return page.evaluate(() => {
          const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
          if (!meta) throw new Error('the runtime document wrote no Content-Security-Policy');
          return meta.getAttribute('content');
        });
      };
      const index = await policyOf('index.html');
      const host = await policyOf('host.html');
      assert.ok(!index.includes("'unsafe-eval'"), `index.html must never write 'unsafe-eval': ${index}`);
      // 'wasm-unsafe-eval' is a different token and index.html has always had it; the check above
      // must not be passing merely because the assertion is looking at the wrong string.
      assert.ok(index.includes("'wasm-unsafe-eval'"), `index.html must still write 'wasm-unsafe-eval': ${index}`);
      assert.equal([...host.matchAll(/(?<!-)'unsafe-eval'/g)].length, 1, `host.html must write 'unsafe-eval' exactly once: ${host}`);
      assert.equal(host.replace(" 'unsafe-eval'", ''), index, 'one token must be the whole difference between the two policies');
      const directives = Object.fromEntries(host.split('; ').map(directive => [directive.split(' ')[0], directive]));
      assert.ok(directives['script-src'].includes("'unsafe-eval'"), `'unsafe-eval' must be in script-src: ${host}`);
      for (const [name, directive] of Object.entries(directives)) {
        if (name !== 'script-src') assert.ok(!/(?<!-)'unsafe-eval'/.test(directive), `${name} must not carry 'unsafe-eval': ${directive}`);
      }
      // What the security model rests on for host JavaScript, asserted on the policy each document
      // actually wrote rather than left to a reader of the shell's source: nothing loads by default;
      // the shell may connect back to ONE source, its own runtime directory (the document's
      // directory, which holds its assets) — the pin that keeps an author's host JavaScript off
      // /api and off every other origin; and no form, frame or base can point anywhere at all. Both
      // documents, so the host document cannot be the one that quietly gains a source.
      const runtimeDirectory = `${origin}/hosted-runtime/`;
      for (const [document, policy] of [['index.html', index], ['host.html', host]]) {
        const sources = Object.fromEntries(policy.split(';').map(d => d.trim()).filter(Boolean).map(d => { const [name, ...rest] = d.split(/\s+/); return [name, rest]; }));
        assert.deepEqual(sources['default-src'], ["'none'"], `${document} must write default-src 'none': ${policy}`);
        assert.deepEqual(sources['connect-src'], [runtimeDirectory], `${document} must write connect-src as exactly its runtime directory ${runtimeDirectory} and no other source: ${policy}`);
        assert.deepEqual(sources['form-action'], ["'none'"], `${document} must write form-action 'none': ${policy}`);
        assert.deepEqual(sources['frame-src'], ["'none'"], `${document} must write frame-src 'none': ${policy}`);
        assert.deepEqual(sources['base-uri'], ["'none'"], `${document} must write base-uri 'none': ${policy}`);
      }
      assert.deepEqual(errors, [], 'The browser must not report uncaught exceptions');
      assert.equal(wasmRequests.length, 0, 'Loading a runtime document must not fetch an engine');
      console.log(`PASS ${order}: index.html and host.html differ by exactly one script-src token, and both pin default-src/connect-src/form-action/frame-src/base-uri, read from the running documents`);
      await context.close();
      continue;
    }
    // A verified owner's app, end to end on the real production runtime: the frame mounts the
    // host document, the author's logic runs as that document's own JavaScript, and no WASM is
    // fetched at all because there is no VM to load.
    if (order === 'host-js-frame') {
      await page.goto(`${origin}/e2e/fixtures/zipp-sharing.html?engine=host-js`);
      await page.getByRole('button', { name: 'Open app', exact: true }).click();
      await expect(page.locator('iframe')).toHaveAttribute('src', '/hosted-runtime/host.html');
      const frame = page.getByTestId('app-0').frameLocator('iframe');
      await expect(frame.getByTestId('count')).toHaveText('0', { timeout: 60_000 });
      await frame.getByRole('button', { name: 'Add one' }).click();
      await expect(frame.getByTestId('count')).toHaveText('1');
      await frame.getByRole('button', { name: 'Check backend' }).click();
      await expect(frame.getByTestId('backend')).toHaveText('Connected');
      // The containment is unchanged, and nothing was downloaded to provide the engine.
      await expect(page.locator('iframe').first()).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(page.locator('iframe').first()).toHaveAttribute('referrerpolicy', 'no-referrer');
      assert.equal(wasmRequests.length, 0, `Host JavaScript must fetch no engine: ${wasmRequests.join(', ')}`);
      assert.deepEqual(errors, [], 'The browser must not report uncaught exceptions');
      console.log(`PASS ${order}: host.html ran the app with 0 WASM requests, sandbox=allow-scripts`);
      await context.close();
      continue;
    }
    // An app whose logic is Python, on the engine the server would have clamped it onto. One
    // client file name apart from every other order here: the bundle's `.py` file is what makes
    // it a Python app, the shell derives that from the name and holds the engine to it, and this
    // is the only check that the author's Python actually RUNS in a real browser frame.
    if (order === 'python-app') {
      await page.goto(`${origin}/e2e/fixtures/zipp-sharing.html?logic=python`);
      await page.getByRole('button', { name: 'Open app', exact: true }).click();
      await expect(page.locator('iframe')).toHaveAttribute('src', '/hosted-runtime/index.html');
      const frame = page.getByTestId('app-0').frameLocator('iframe');
      await expect(frame.getByTestId('count')).toHaveText('0', { timeout: 60_000 });
      await frame.getByRole('button', { name: 'Add one' }).click();
      await expect(frame.getByTestId('count')).toHaveText('1');
      assert.equal(wasmRequests.length, 1, `Python needs the one ZIPP engine, once: ${wasmRequests.join(', ')}`);
      assert.deepEqual(errors, [], 'The browser must not report uncaught exceptions');
      console.log(`PASS ${order}: a .py bundle ran on index.html, state mirrored and a handler called`);
      await context.close();
      continue;
    }
    await page.goto(`${origin}/e2e/fixtures/zipp-sharing.html`);
    await page.getByRole('button', { name: 'Open app', exact: true }).waitFor();
    assert.equal(wasmRequests.length, 0, 'Ordinary pages must not preload the engine');
    const evaluate = async () => {
      await page.getByRole('button', { name: 'Evaluate expression' }).click();
      await expect(page.getByTestId('answer')).toHaveText('42', { timeout: 60_000 });
    };
    const checkApp = async (id = 0) => {
      const frame = page.getByTestId(`app-${id}`).frameLocator('iframe');
      await expect(frame.getByTestId('count')).toHaveText('0', { timeout: 60_000 });
      await frame.getByRole('button', { name: 'Add one' }).click();
      await expect(frame.getByTestId('count')).toHaveText('1');
      return frame;
    };
    const openApp = async (id = 0) => {
      await page.getByRole('button', { name: 'Open app', exact: true }).click();
      return checkApp(id);
    };
    if (order === 'stale-host') {
      await page.getByRole('button', { name: 'Open app', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('out of date');
      assert.equal(wasmRequests.length, 0, 'An incompatible shell must not receive engine bytes');
    } else if (order === 'self-navigation') {
      await page.getByRole('button', { name: 'Open app', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('tried to navigate away');
      await expect(page.locator('iframe')).toHaveCount(0);
      assert.equal(wasmRequests.length, 0, 'A frame that left its runtime must not receive engine bytes');
    } else {
      if (order === 'download-retry') {
        await page.getByRole('button', { name: 'Evaluate expression' }).click();
        await expect(page.getByTestId('answer')).toContainText('Failed:');
        assert.equal(wasmRequests.length, 1);
      }
      let first;
      if (order === 'app-first') { first = await openApp(); await evaluate(); }
      else if (order === 'concurrent') {
        await page.getByRole('button', { name: 'Open and evaluate together' }).click();
        first = await checkApp();
        await expect(page.getByTestId('answer')).toHaveText('42', { timeout: 60_000 });
      }
      else { await evaluate(); first = await openApp(); }
      await first.getByRole('button', { name: 'Check backend' }).click();
      await expect(first.getByTestId('backend')).toHaveText('Connected');
      const second = await openApp(1);
      await second.getByRole('button', { name: 'Add one' }).click();
      await expect(second.getByTestId('count')).toHaveText('2');
      await expect(first.getByTestId('count')).toHaveText('1');
      await expect(page.locator('iframe').first()).toHaveAttribute('sandbox', 'allow-scripts');
      await page.getByRole('button', { name: 'Close apps' }).click();
      await expect(page.locator('iframe')).toHaveCount(0);
      await openApp();
      await evaluate();
      await page.getByRole('button', { name: 'Replace app source' }).click();
      const updated = page.getByTestId('app-0').frameLocator('iframe');
      await expect(updated.getByTestId('count')).toHaveText('10', { timeout: 60_000 });
      await updated.getByRole('button', { name: 'Add one' }).click();
      await expect(updated.getByTestId('count')).toHaveText('11');
      await updated.getByRole('button', { name: 'Check backend' }).click();
      await expect(updated.getByTestId('backend')).toHaveText('Connected');
      assert.equal(wasmRequests.length, order === 'download-retry' ? 2 : 1, `Unexpected WASM downloads: ${wasmRequests.join(', ')}`);
      assert(wasmRequests.every(url => !url.includes('/hosted-runtime/')), 'Hosted apps must reuse parent bytes');
    }
    assert.deepEqual(errors, [], 'The browser must not report uncaught exceptions');
    console.log(`PASS ${order}: ${wasmRequests.length} WASM request(s), isolated app state, real production runtime`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  // output is the exact directory created by mkdtemp above, never a project dist.
  assert.equal(dirname(output), tmpdir());
  await rm(output, { recursive: true, force: true });
}
