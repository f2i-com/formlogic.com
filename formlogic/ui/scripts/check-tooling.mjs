// Exercises the real production editor bundle and its workers without accounts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'e2e/fixtures/editor-tooling.html');
const output = await mkdtemp(join(tmpdir(), 'formlogic-editor-tooling-'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
let server;
let browser;
try {
  await build({
    root, configFile: false, publicDir: false, plugins: [react()], worker: { format: 'es' },
    build: { outDir: output, emptyOutDir: true, rolldownOptions: { input: fixture } },
  });
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(output, pathname.slice(1) || 'e2e/fixtures/editor-tooling.html');
    if (!file.startsWith(resolve(output) + sep)) { response.writeHead(403).end(); return; }
    try {
      response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Check TypeScript worker' }).click();
  await expect(page.getByRole('status', { name: 'Worker result' })).toHaveText('TypeScript worker: 0 syntax errors');
  await page.getByRole('button', { name: 'Focus editor' }).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nconst nextVisit = "Friday";', { delay: 30 });
  await expect(page.getByLabel('Editor value')).toContainText('const nextVisit = "Friday";');
  await page.getByRole('button', { name: 'Show booking help' }).click();
  await expect(page.locator('.monaco-hover strong', { hasText: 'Booking help' })).toBeVisible();
  assert.deepEqual(errors, [], 'the bundled editor must run without browser errors');
  console.log('PASS production editor editing, TypeScript worker, and formatted hover');
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (!resolve(output).startsWith(resolve(tmpdir(), 'formlogic-editor-tooling-'))) throw new Error('Unexpected tooling output path');
  await rm(output, { recursive: true, force: true });
}
