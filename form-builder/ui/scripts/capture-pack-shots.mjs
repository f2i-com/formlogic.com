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
  // SPA's credentialed cross-origin calls to the API (same registrable domain). The session can be
  // invalidated MID-RUN (a burst of ~19 dashboards can trip per-user rate limits, which the SPA
  // treats as expiry and purges) — so re-minting is available to the retry loop below.
  const mintSession = async () => {
    const r = await context.request.post(`${API_BASE}/demo/start`, { headers: { 'Content-Type': 'application/json' }, data: {} });
    return r.ok();
  };
  if (!(await mintSession())) { log('demo/start failed'); await browser.close(); process.exit(1); }

  const page = await context.newPage();

  async function snap(appSlug, file) {
    await page.goto(`${APP_BASE}/app/${appSlug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    // Session dropped mid-run → the app shell shows its auth guard instead of the dashboard.
    if (await page.getByText('Sign in to continue').count()) {
      await mintSession();
      await page.waitForTimeout(600);
      await page.goto(`${APP_BASE}/app/${appSlug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    // The dashboard is now a host-rendered widget grid (recharts, no iframe). Wait for the charts to
    // paint (batched report run + animation) before snapping.
    await page.waitForSelector('svg.recharts-surface', { timeout: 30000 });
    await page.waitForTimeout(3800);

    const outPath = resolve(OUT_DIR, file);
    // 16:10 crop of the dashboard content region (inside <main>, excluding the sidebar), starting at
    // the first widget card so the owner "Edit dashboard" bar isn't in the thumbnail.
    const main = await page.locator('#app-main-content').boundingBox();
    const card = await page.locator('#app-main-content .rounded-2xl').first().boundingBox();
    if (main && main.width > 200) {
      const x = Math.max(0, Math.round(main.x));
      const y = Math.max(0, Math.round((card?.y ?? main.y) - 8));
      const width = Math.min(Math.round(main.width), 1360 - x);
      const height = Math.min(Math.round(width * 0.625), 850 - y);
      await page.screenshot({ path: outPath, clip: { x, y, width, height } });
    } else {
      await page.screenshot({ path: outPath });
    }
  }

  let ok = 0;
  for (const { catalogSlug, appSlug, label, file } of manifest) {
    const outFile = file || `${catalogSlug}.png`;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await snap(appSlug, outFile);
        ok++;
        log(`✓ ${outFile}  (${label || catalogSlug})`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await mintSession(); // most mid-run failures are a dropped demo session
        await page.waitForTimeout(800);
      }
    }
    if (lastErr) log(`✗ ${outFile}  (${label || catalogSlug}) — ${lastErr.message}`);
  }

  await browser.close();
  log(`\nCaptured ${ok}/${manifest.length} → ${OUT_DIR}`);
  log('Now run: php scripts/provision-demo.php   (to link the images onto the catalog)');
}

main().catch((e) => { log('Fatal: ' + e.message); process.exit(1); });
