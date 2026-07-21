/**
 * Plugin-shipped SANDBOXED screens — pure logic for the host renderer.
 *
 * A manifest v2 plugin may ship interactive UI bundles inside its (signed)
 * package: `ui.screens` = [{ id, title, entry(.html), files[] }], served by
 * the Rust route `GET /api/plugins/:id/ui/:screen/*path` (exact file-list
 * match, no directory walking, Cache-Control: no-store). A `ui.nav` entry
 * that declares `screen` opens one.
 *
 * This module is the unit-testable half of the host: srcDoc composition
 * (CSP + SDK shim + generation stamp), asset assembly, the journalled
 * requestId mint, and the postMessage classification/refusal rules.
 * The React half (PluginScreenPage.tsx) wires these against api.ts.
 *
 * SECURITY MODEL (mirrors the web app's CustomScreenRuntime):
 *  - the iframe runs with sandbox="allow-scripts" and NO allow-same-origin,
 *    so screen code executes in an OPAQUE origin: no cookies, no parent DOM,
 *    no localStorage, and no credentialed API access;
 *  - the CSP meta forbids ALL network (connect-src 'none', default-src
 *    'none') — every asset is inlined into the srcDoc at compose time;
 *  - the ONLY way out is `window.PluginHost`, a postMessage RPC the parent
 *    answers; the parent closes over THIS plugin's id, so screen code can
 *    structurally never name another plugin;
 *  - each composed document carries a generation stamp; a reloaded iframe's
 *    stale predecessor (the WindowProxy survives a srcdoc update) is refused.
 */

/** One manifest v2 `ui.screens` entry, as it rides the plugin snapshot. */
export interface PluginScreenDecl {
  id: string;
  title: string;
  /** The entry document (always .html, always listed in `files`). */
  entry: string;
  /** The complete servable file set (package-relative paths). */
  files: string[];
}

/** The assembled screen bundle the iframe renders. */
export interface PluginScreenAssets {
  /** Entry document body content (inner <body> when present, else the whole text). */
  html: string;
  /** All .css files, concatenated in files-list order. */
  css: string;
  /** All .js files, concatenated in files-list order. */
  js: string;
}

/**
 * Strict CSP for the sandboxed screen document. No network of any kind —
 * scripts/styles are inline-only (the host inlines the bundle), images and
 * fonts may only be data: URIs the bundle carries inside its own CSS/JS.
 */
export const PLUGIN_SCREEN_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * The SDK shim injected into <head> BEFORE any screen code, defining
 * `window.PluginHost`. Every method is a postMessage RPC to the parent:
 *
 *   child → parent : { __pluginScreen: <gen>, callId, op, args }
 *   parent → child : { __pluginScreenReply: true, callId, result?, error? }
 *   parent → child : { __pluginScreenPush: true, gen, subId, frame }   (event feeds)
 *   parent → child : { __pluginScreenTheme: 'dark' | 'light' }         (theme flips)
 *
 * `__phGen` identifies THIS document instance (stamped by the host into the
 * srcDoc) — the parent refuses messages from any other generation, and the
 * shim drops pushes stamped for another generation.
 *
 * The op surface (the contract plugin screen bundles code against):
 *   command(cmd, payload?)             → op 'command'          {command, payload}
 *   consent.get()                      → op 'consentGet'       {}
 *   consent.issue(grant)               → op 'consentIssue'     {grant}
 *   companionPairing.status()          → op 'companionPairing' {op:'status', args:[]}
 *   companionPairing.createOffer(body)                 {op:'createOffer', args:[body]}
 *   companionPairing.receiveResponse(response)         {op:'receiveResponse', args:[response]}
 *   companionPairing.approve(id) / .deny(id)           {op:'approve'|'deny', args:[id]}
 *   companionPairing.revoke(thumbprint)                {op:'revoke', args:[thumbprint]}
 *   companionPairing.rotateDesktopKey()                {op:'rotateDesktopKey', args:[]}
 *   aiSources()                        → op 'aiSources'        {}
 *   snapshot()                         → op 'snapshot'         {}
 *   restartPlugin()                    → op 'restartPlugin'    {}
 *   events.subscribe(names?, cb)       → op 'eventsSubscribe'  {names?}   → {subId}
 *     (handle.unsubscribe()            → op 'eventsUnsubscribe' {subId})
 *   toast(kind, msg)                   → op 'toast'            {kind, msg}
 *   theme.current()                    → local (reads the fl-dark class)
 *   theme.onChange(cb)                 → local (invoked on __pluginScreenTheme)
 */
export const PLUGIN_SCREEN_SHIM = `
(function(){
  var pending = {}, seq = 0, subs = {}, themeCbs = [];
  function call(op, args){
    return new Promise(function(resolve, reject){
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __pluginScreen: window.__phGen, callId: id, op: op, args: args || {} }, '*');
    });
  }
  window.addEventListener('message', function(e){
    var m = e.data;
    if (!m) return;
    if (m.__pluginScreenPush) {
      if (m.gen !== window.__phGen) return;
      var h = subs[m.subId];
      if (h) { try { h(m.frame); } catch (err) {} }
      return;
    }
    if (m.__pluginScreenTheme) {
      var dark = m.__pluginScreenTheme === 'dark';
      document.documentElement.classList.toggle('fl-dark', dark);
      for (var i = 0; i < themeCbs.length; i++) { try { themeCbs[i](dark ? 'dark' : 'light'); } catch (err) {} }
      return;
    }
    if (!m.__pluginScreenReply || !pending[m.callId]) return;
    var p = pending[m.callId]; delete pending[m.callId];
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  window.PluginHost = {
    /** Run one of THIS plugin's connector commands. Journalled commands get a durable requestId minted by the host. Resolves the command's data. */
    command: function(cmd, payload){ return call('command', { command: String(cmd == null ? '' : cmd), payload: payload }); },
    consent: {
      /** The plugin's consent status (its own 'consent.get' command). */
      get: function(){ return call('consentGet', {}); },
      /** Issue a Desktop-SIGNED consent grant: { scopes, version?, acceptedBy?, expiresDays? }. */
      issue: function(grant){ return call('consentIssue', { grant: grant || {} }); },
    },
    /** Companion mobile pairing broker (host-gated: only the broker plugin's own screens may call these). */
    companionPairing: {
      status: function(){ return call('companionPairing', { op: 'status', args: [] }); },
      createOffer: function(body){ return call('companionPairing', { op: 'createOffer', args: [body || {}] }); },
      receiveResponse: function(response){ return call('companionPairing', { op: 'receiveResponse', args: [response] }); },
      approve: function(id){ return call('companionPairing', { op: 'approve', args: [String(id == null ? '' : id)] }); },
      deny: function(id){ return call('companionPairing', { op: 'deny', args: [String(id == null ? '' : id)] }); },
      revoke: function(thumbprint){ return call('companionPairing', { op: 'revoke', args: [String(thumbprint == null ? '' : thumbprint)] }); },
      rotateDesktopKey: function(){ return call('companionPairing', { op: 'rotateDesktopKey', args: [] }); },
    },
    /** The desktop's AI source listing (services + providers, capability-tagged). Resolves an array. */
    aiSources: function(){ return call('aiSources', {}); },
    /** THIS plugin's current snapshot (state/health/ui/events), or null while unknown. */
    snapshot: function(){ return call('snapshot', {}); },
    /** Restart THIS plugin — the sanctioned way to apply settings that only
     *  take effect at plugin start (e.g. the voice-engine mode). The screen
     *  keeps running; the plugin reconnects underneath it. */
    restartPlugin: function(){ return call('restartPlugin', {}); },
    events: {
      /** Live plugin events. names (optional) must be a subset of the events THIS plugin's
       *  manifest declares; omitted = all of them. cb receives { name, data }. Resolves
       *  { unsubscribe }. Feeds stop when the screen reloads. */
      subscribe: function(names, cb){
        if (typeof names === 'function') { cb = names; names = undefined; }
        return call('eventsSubscribe', { names: names }).then(function(r){
          subs[r.subId] = cb;
          return { unsubscribe: function(){ delete subs[r.subId]; return call('eventsUnsubscribe', { subId: r.subId }); } };
        });
      },
    },
    /** Host toast: kind 'success' | 'error' | 'info'. */
    toast: function(kind, msg){ return call('toast', { kind: String(kind == null ? '' : kind), msg: String(msg == null ? '' : msg) }); },
    theme: {
      /** The mode this document is currently rendered in. */
      current: function(){ return document.documentElement.classList.contains('fl-dark') ? 'dark' : 'light'; },
      /** cb('dark'|'light') on every host theme flip. Returns an un-listen function. */
      onChange: function(cb){
        themeCbs.push(cb);
        return function(){ var i = themeCbs.indexOf(cb); if (i >= 0) themeCbs.splice(i, 1); };
      },
    },
  };
})();
`;

/**
 * Compose the sandboxed iframe's srcDoc: strict CSP, the theme class, the SDK
 * shim (in <head>, BEFORE any screen code), the inlined bundle. `gen` is the
 * document generation stamp — bump it on every rebuild so the parent can
 * refuse the dying predecessor's messages.
 */
export function composeScreenSrcDoc(opts: {
  html: string;
  css: string;
  js: string;
  dark: boolean;
  gen: number;
}): string {
  // Neutralize an early </script> in screen js so it can't break out of its
  // <script> block (document-structure hygiene — the code is sandboxed anyway).
  const js = opts.js.replace(/<\/script>/gi, '<\\/script>');
  const gen = Math.floor(opts.gen);
  return (
    `<!doctype html><html class="${opts.dark ? 'fl-dark' : ''}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_SCREEN_CSP}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="color-scheme" content="light dark">`
    + `<script>var __phGen=${gen};${PLUGIN_SCREEN_SHIM}</script>`
    // color-scheme follows the fl-dark class so native widget chrome (select
    // popups, scrollbars) flips with the host theme — same lesson as the web
    // runtime's screenTheme.ts.
    + `<style>html,body{margin:0;font-family:system-ui,sans-serif}`
    + `html{color-scheme:light}html.fl-dark{color-scheme:dark}${opts.css}</style></head>`
    + `<body>${opts.html}<script>${js}</script></body></html>`
  );
}

/**
 * Entry-document body extraction: if the entry contains <body>…</body> use
 * its inner content, else the whole text (deliberately simple — a bundle's
 * entry is expected to be a fragment or a plain page, not arbitrary HTML).
 */
export function extractEntryBody(text: string): string {
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
  return m ? m[1].trim() : text;
}

/**
 * Fetch + assemble a screen bundle: the entry document plus every .css and
 * .js file, concatenated in files-list order. Non-inlinable assets (.svg,
 * .png, .json, .woff2, .mjs) are NOT fetched — with connect-src 'none' the
 * document can't load them by URL either; bundles embed such assets as
 * data: URIs inside their own CSS/JS.
 */
export async function screenAssets(
  screen: { entry: string; files: string[] },
  fetcher: (relPath: string) => Promise<string>,
): Promise<PluginScreenAssets> {
  const cssFiles = screen.files.filter((f) => f.endsWith('.css'));
  const jsFiles = screen.files.filter((f) => f.endsWith('.js'));
  const [entryText, cssParts, jsParts] = await Promise.all([
    fetcher(screen.entry),
    Promise.all(cssFiles.map(fetcher)),
    Promise.all(jsFiles.map(fetcher)),
  ]);
  return {
    html: extractEntryBody(entryText),
    css: cssParts.join('\n'),
    js: jsParts.join('\n;'),
  };
}

/** The serving-route path for one screen asset (each segment URI-encoded,
 *  the relative path's own slashes preserved as path separators). */
export function screenAssetPath(pluginId: string, screenId: string, relPath: string): string {
  const rel = relPath.split('/').map(encodeURIComponent).join('/');
  return `/api/plugins/${encodeURIComponent(pluginId)}/ui/${encodeURIComponent(screenId)}/${rel}`;
}

/**
 * Resolve the screen a plugin nav entry opens: the entry must declare
 * `screen` AND the id must exist in the snapshot's `ui.screens`. Anything
 * else → null (the caller falls back to the declarative contributed screen —
 * byte-compatible with pre-screens manifests).
 */
export function pluginNavScreen(
  ui:
    | {
        nav?: { id: string; screen?: string }[];
        screens?: PluginScreenDecl[];
      }
    | undefined,
  navId: string,
): PluginScreenDecl | null {
  const nav = ui?.nav?.find((n) => n.id === navId);
  const screenId = nav?.screen;
  if (!screenId) return null;
  return ui?.screens?.find((s) => s.id === screenId) ?? null;
}

type RequestIdGenerator = () => string;

const defaultGenerator: RequestIdGenerator = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Tauri's WebView supplies randomUUID; this fallback keeps plain-browser
  // dev + node tests functional with only plugin-safe characters.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Mint a durable requestId for a screen-invoked command when the plugin's
 * MANIFEST marks it journalled (snapshot `journalledCommands`). A journalled
 * command without an id would be refused by the plugin; a non-journalled
 * command returns null (no id sent).
 */
export function journalledRequestIdFor(
  journalledCommands: readonly string[] | undefined,
  command: string,
  generate: RequestIdGenerator = defaultGenerator,
): string | null {
  if (!journalledCommands || !journalledCommands.includes(command)) return null;
  const commandTag = command.replaceAll('.', '-');
  return `screen-${commandTag}-${generate()}`;
}

/** Classification of one window message against the CURRENT document generation. */
export type ScreenRpcParse =
  | { kind: 'ignore' }
  /** A structurally valid RPC from a STALE generation — reply with an honest refusal. */
  | { kind: 'stale'; callId: number }
  | { kind: 'rpc'; callId: number; op: string; args: Record<string, unknown> };

/**
 * Parse a candidate RPC message from the iframe. The iframe's WindowProxy
 * survives a srcdoc update and the dying predecessor document keeps draining
 * its task queue briefly — its messages carry the OLD generation stamp and
 * must be refused, never acted on (the web runtime's __flGen lesson).
 * The caller has already verified e.source === the iframe's contentWindow.
 */
export function parseScreenRpcMessage(data: unknown, currentGen: number): ScreenRpcParse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'ignore' };
  const m = data as Record<string, unknown>;
  if (typeof m.__pluginScreen !== 'number' || typeof m.callId !== 'number') {
    return { kind: 'ignore' };
  }
  if (m.__pluginScreen !== currentGen) return { kind: 'stale', callId: m.callId };
  if (typeof m.op !== 'string' || m.op === '') return { kind: 'ignore' };
  const args =
    m.args && typeof m.args === 'object' && !Array.isArray(m.args)
      ? (m.args as Record<string, unknown>)
      : {};
  return { kind: 'rpc', callId: m.callId, op: m.op, args };
}

/**
 * Validate an events.subscribe names filter against the plugin's DECLARED
 * manifest events. Omitted names = all declared events; any name outside the
 * declaration is refused (a screen can only observe its own plugin's feed).
 */
export function resolveEventSubscriptionNames(
  declared: readonly string[],
  requested: unknown,
): { ok: true; names: string[] } | { ok: false; error: string } {
  if (declared.length === 0) {
    return { ok: false, error: 'This plugin declares no events to subscribe to.' };
  }
  if (requested == null) return { ok: true, names: [...new Set(declared)] };
  if (!Array.isArray(requested)) {
    return { ok: false, error: 'events.subscribe() names must be an array of event names.' };
  }
  const names: string[] = [];
  for (const raw of requested) {
    const name = String(raw ?? '');
    if (!declared.includes(name)) {
      return { ok: false, error: `This plugin does not declare the event ${JSON.stringify(name)}.` };
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) {
    return { ok: false, error: 'events.subscribe() got an empty names filter.' };
  }
  return { ok: true, names };
}
