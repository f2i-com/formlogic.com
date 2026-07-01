/**
 * Auto-capture marketplace thumbnails for every catalog pack.
 *
 * Renders each demo app's dashboard headlessly and snaps a clean 16:10 crop, so the marketplace
 * shows a real preview of the app you'd install — captured automatically once the app is published.
 *
 * Pipeline:  php scripts/provision-demo.php   (emits the manifest)
 *         →  node scripts/capture-pack-shots.mjs
 *         →  php scripts/provision-demo.php   (links the images onto the catalog)
 *
 * Reads the manifest at backend/storage/pack-screenshots/manifest.json (catalogSlug → demo appSlug),
 * writes <catalogSlug>.png. By default images land in resources/pack-screenshots (committed so a
 * fresh clone has thumbnails after provisioning); pass --out=storage to keep them runtime-only.
 *
 * Env: APP_BASE (SPA origin, default http://formlogic.local), API_BASE (default
 *      http://api.formlogic.local/api), THEME (light|dark, default light).
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(__dirname, '../../backend');

const APP_BASE = (process.env.APP_BASE || 'http://formlogic.local').replace(/\/$/, '');
const API_BASE = (process.env.API_BASE || 'http://api.formlogic.local/api').replace(/\/$/, '');
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';
const OUT_ARG = (process.argv.find((a) => a.startsWith('--out=')) || '').split('=')[1];
const OUT_DIR = resolve(BACKEND, OUT_ARG === 'storage' ? 'storage/pack-screenshots' : 'resources/pack-screenshots');
const MANIFEST = resolve(BACKEND, 'storage/pack-screenshots/manifest.json');

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

function log(m) { process.stdout.write(m + '\n'); }

async function main() {
  if (!existsSync(MANIFEST)) {
    log(`No manifest at ${MANIFEST}. Run: php scripts/provision-demo.php`);
    process.exit(1);
  }
  let manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (only) manifest = manifest.filter((m) => m.catalogSlug === only || m.appSlug === only);
  if (!manifest.length) { log('Manifest empty (nothing to capture).'); return; }
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1360, height: 850 },
    deviceScaleFactor: 2, // crisp thumbnails on retina/marketplace cards
  });

  // Seed the persisted UI theme before any app code runs, so the whole set is captured consistently.
  await context.addInitScript((theme) => {
    try {
      localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme }, version: 0 }));
    } catch { /* ignore */ }
  }, THEME);

  // Authenticate as the shared Demo account; the cookie is stored in the context jar and sent on the
  // SPA's credentialed cross-origin calls to the API (same registrable domain).
  const start = await context.request.post(`${API_BASE}/demo/start`, { headers: { 'Content-Type': 'application/json' }, data: {} });
  if (!start.ok()) { log(`demo/start failed: ${start.status()}`); await browser.close(); process.exit(1); }

  const page = await context.newPage();

  async function snap(appSlug, file) {
    await page.goto(`${APP_BASE}/app/${appSlug}`, { waitUntil: 'networkidle', timeout: 30000 });
    // The dashboard is a sandboxed iframe; wait for it to mount, then give the SDK time to fetch
    // records and paint charts before snapping.
    await page.waitForSelector('iframe', { timeout: 30000 });
    await page.waitForTimeout(2800);

    const frame = page.locator('iframe').first();
    const box = await frame.boundingBox();
    const outPath = resolve(OUT_DIR, file);
    if (box && box.width > 200) {
      // 16:10 crop from the top of the dashboard region → an even, attractive card thumbnail.
      const width = Math.min(box.width, 1360 - box.x);
      const height = Math.min(box.height, Math.round(width * 0.625));
      await page.screenshot({ path: outPath, clip: { x: box.x, y: box.y, width, height } });
    } else {
      await page.screenshot({ path: outPath });
    }
  }

  let ok = 0;
  for (const { catalogSlug, appSlug, label, file } of manifest) {
    const outFile = file || `${catalogSlug}.png`;
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await snap(appSlug, outFile);
        ok++;
        log(`✓ ${outFile}  (${label || catalogSlug})`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) log(`✗ ${outFile}  (${label || catalogSlug}) — ${lastErr.message}`);
  }

  await browser.close();
  log(`\nCaptured ${ok}/${manifest.length} → ${OUT_DIR}`);
  log('Now run: php scripts/provision-demo.php   (to link the images onto the catalog)');
}

main().catch((e) => { log('Fatal: ' + e.message); process.exit(1); });
