/**
 * Perf sanity check for the demo dashboards. Opens the first N demo apps and measures how long until
 * the dashboard's charts have painted (batched report run + recharts animation settled). Reports each
 * app's time and fails if any exceeds THRESHOLD_MS. Dev/QA tool — needs a running site, not CI.
 *
 * Usage: node scripts/perf-demo-dashboards.mjs [count]
 * Env: APP_BASE (default http://formlogic.local), API_BASE (default http://api.formlogic.local/api),
 *      THRESHOLD_MS (default 6000).
 */
import { chromium } from 'playwright';

const APP_BASE = (process.env.APP_BASE || 'http://formlogic.local').replace(/\/$/, '');
const API_BASE = (process.env.API_BASE || 'http://api.formlogic.local/api').replace(/\/$/, '');
const THRESHOLD_MS = Number(process.env.THRESHOLD_MS || 6000);
const COUNT = Number(process.argv[2] || 8);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.request.post(`${API_BASE}/demo/start`, { headers: { 'Content-Type': 'application/json' }, data: {} });

// Discover demo apps.
const res = await ctx.request.get(`${API_BASE}/demo/apps`);
const body = await res.json().catch(() => ({}));
const apps = (body.apps ?? body.data?.apps ?? []).slice(0, COUNT);
if (!apps.length) { console.error('No demo apps found.'); await browser.close(); process.exit(1); }

const page = await ctx.newPage();
let slow = 0;
console.log(`Measuring first-chart paint for ${apps.length} demo dashboards (threshold ${THRESHOLD_MS}ms):\n`);
for (const app of apps) {
  const t0 = Date.now();
  let ms, ok = true;
  try {
    await page.goto(`${APP_BASE}/app/${app.slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('svg.recharts-surface', { timeout: 20000 });
    ms = Date.now() - t0;
  } catch {
    ms = Date.now() - t0; ok = false;
  }
  const flag = !ok ? 'FAIL (no chart)' : ms > THRESHOLD_MS ? 'SLOW' : 'ok';
  if (!ok || ms > THRESHOLD_MS) slow++;
  console.log(`  ${String(ms).padStart(6)} ms  ${flag.padEnd(14)} ${app.name}`);
}
await browser.close();
console.log(`\n${slow === 0 ? '✓' : '✗'} ${apps.length - slow}/${apps.length} dashboards within ${THRESHOLD_MS}ms.`);
process.exit(slow === 0 ? 0 : 1);
