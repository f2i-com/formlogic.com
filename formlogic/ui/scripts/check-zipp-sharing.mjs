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
  for (const order of ['expression-first', 'app-first', 'concurrent', 'without-webcrypto', 'download-retry', 'stale-host', 'self-navigation']) {
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
