import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeScreenSrcDoc,
  extractEntryBody,
  journalledRequestIdFor,
  parseScreenRpcMessage,
  pluginNavScreen,
  resolveEventSubscriptionNames,
  screenAssetPath,
  screenAssets,
  PLUGIN_SCREEN_CSP,
} from './pluginScreens.ts';

// ---- composeScreenSrcDoc ----

test('srcDoc carries the strict no-network CSP', () => {
  const doc = composeScreenSrcDoc({ html: '<p>hi</p>', css: '', js: '', dark: false, gen: 1 });
  assert.ok(doc.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(doc.includes(PLUGIN_SCREEN_CSP));
  assert.ok(PLUGIN_SCREEN_CSP.includes("default-src 'none'"));
  assert.ok(PLUGIN_SCREEN_CSP.includes("connect-src 'none'"));
  assert.ok(PLUGIN_SCREEN_CSP.includes("script-src 'unsafe-inline'"));
  assert.ok(PLUGIN_SCREEN_CSP.includes("style-src 'unsafe-inline'"));
  assert.ok(PLUGIN_SCREEN_CSP.includes('img-src data:'));
});

test('srcDoc sets the fl-dark class only in dark mode', () => {
  const dark = composeScreenSrcDoc({ html: '', css: '', js: '', dark: true, gen: 1 });
  const light = composeScreenSrcDoc({ html: '', css: '', js: '', dark: false, gen: 1 });
  assert.ok(dark.includes('<html class="fl-dark">'));
  assert.ok(light.includes('<html class="">'));
  // Native widget chrome follows the class through CSS color-scheme.
  assert.ok(dark.includes('html.fl-dark{color-scheme:dark}'));
});

test('srcDoc injects the SDK shim + generation stamp BEFORE the screen js', () => {
  const doc = composeScreenSrcDoc({
    html: '<div id="app"></div>',
    css: '.x{color:red}',
    js: 'window.PluginHost.command("health.get");',
    dark: false,
    gen: 7,
  });
  const shimAt = doc.indexOf('window.PluginHost = {');
  const stampAt = doc.indexOf('var __phGen=7;');
  const userAt = doc.indexOf('window.PluginHost.command("health.get")');
  assert.ok(stampAt >= 0, 'generation stamp baked into the document');
  assert.ok(shimAt >= 0, 'shim present');
  assert.ok(userAt >= 0, 'user js present');
  assert.ok(stampAt < shimAt, 'stamp precedes the shim');
  assert.ok(shimAt < userAt, 'shim precedes user code');
  assert.ok(doc.includes('.x{color:red}'), 'screen css inlined');
});

test('srcDoc neutralizes </script> inside screen js', () => {
  const doc = composeScreenSrcDoc({
    html: '',
    css: '',
    js: 'var s = "</script><img src=x>";',
    dark: false,
    gen: 1,
  });
  assert.ok(doc.includes('var s = "<\\/script><img src=x>";'));
  // Only the structural closers remain: the shim's and the user block's.
  assert.equal(doc.split('</script>').length - 1, 2);
});

// ---- screenAssets ----

test('screenAssets fetches entry + css + js in files-list order, skipping other assets', async () => {
  const fetched: string[] = [];
  const contents: Record<string, string> = {
    'ui/index.html':
      '<!doctype html><html><head><title>t</title></head><body class="x">HELLO <b>world</b></body></html>',
    'ui/a.css': '.a{}',
    'ui/sub/b.css': '.b{}',
    'ui/one.js': 'one()',
    'ui/two.js': 'two()',
  };
  const assets = await screenAssets(
    {
      entry: 'ui/index.html',
      files: ['ui/index.html', 'ui/a.css', 'ui/one.js', 'ui/sub/b.css', 'ui/two.js', 'ui/logo.svg', 'ui/mod.mjs'],
    },
    async (rel) => {
      fetched.push(rel);
      const c = contents[rel];
      if (c === undefined) throw new Error(`unexpected fetch: ${rel}`);
      return c;
    },
  );
  assert.equal(assets.html, 'HELLO <b>world</b>');
  assert.equal(assets.css, '.a{}\n.b{}');
  assert.equal(assets.js, 'one()\n;two()');
  // svg/mjs never fetched — they can't be inlined and CSP blocks URL loads.
  assert.ok(!fetched.includes('ui/logo.svg'));
  assert.ok(!fetched.includes('ui/mod.mjs'));
});

test('entry body extraction: inner <body> when present, else the whole text', () => {
  assert.equal(extractEntryBody('<body>\n <p>x</p> \n</body>'), '<p>x</p>');
  assert.equal(extractEntryBody('<body data-a="1">y</body>'), 'y');
  assert.equal(extractEntryBody('<div id="app"></div>'), '<div id="app"></div>');
});

// ---- serving-route path ----

test('screenAssetPath encodes segments but preserves path separators', () => {
  assert.equal(
    screenAssetPath('aokie', 'home', 'ui/receptionist/index.html'),
    '/api/plugins/aokie/ui/home/ui/receptionist/index.html',
  );
  assert.equal(
    screenAssetPath('a b', 'x#y', 'ui/app files/x.js'),
    '/api/plugins/a%20b/ui/x%23y/ui/app%20files/x.js',
  );
});

// ---- journalledRequestIdFor ----

test('journalled command mints a stable-format requestId; others return null', () => {
  const gen = () => 'fixed';
  assert.equal(
    journalledRequestIdFor(['phone.connect', 'call.dial'], 'phone.connect', gen),
    'screen-phone-connect-fixed',
  );
  assert.equal(journalledRequestIdFor(['phone.connect'], 'health.get', gen), null);
  assert.equal(journalledRequestIdFor(undefined, 'phone.connect', gen), null);
  assert.equal(journalledRequestIdFor([], 'phone.connect', gen), null);
  // Default generator produces plugin-safe characters.
  const minted = journalledRequestIdFor(['sms.send'], 'sms.send');
  assert.ok(minted && /^screen-sms-send-[A-Za-z0-9-]+$/.test(minted), `got ${minted}`);
});

// ---- postMessage classification (generation refusal) ----

test('parseScreenRpcMessage refuses stale generations with the callId', () => {
  const stale = parseScreenRpcMessage({ __pluginScreen: 1, callId: 9, op: 'command', args: {} }, 2);
  assert.deepEqual(stale, { kind: 'stale', callId: 9 });
});

test('parseScreenRpcMessage accepts the current generation and defaults args', () => {
  const ok = parseScreenRpcMessage(
    { __pluginScreen: 3, callId: 4, op: 'toast', args: { kind: 'info', msg: 'x' } },
    3,
  );
  assert.deepEqual(ok, { kind: 'rpc', callId: 4, op: 'toast', args: { kind: 'info', msg: 'x' } });
  const noArgs = parseScreenRpcMessage({ __pluginScreen: 3, callId: 5, op: 'snapshot' }, 3);
  assert.deepEqual(noArgs, { kind: 'rpc', callId: 5, op: 'snapshot', args: {} });
  // Array args are not an args object.
  const arrArgs = parseScreenRpcMessage(
    { __pluginScreen: 3, callId: 6, op: 'snapshot', args: [1] },
    3,
  );
  assert.deepEqual(arrArgs, { kind: 'rpc', callId: 6, op: 'snapshot', args: {} });
});

test('parseScreenRpcMessage ignores structurally foreign messages', () => {
  assert.deepEqual(parseScreenRpcMessage(null, 1), { kind: 'ignore' });
  assert.deepEqual(parseScreenRpcMessage('hi', 1), { kind: 'ignore' });
  assert.deepEqual(parseScreenRpcMessage({ callId: 1, op: 'x' }, 1), { kind: 'ignore' });
  assert.deepEqual(parseScreenRpcMessage({ __pluginScreen: '1', callId: 1, op: 'x' }, 1), {
    kind: 'ignore',
  });
  // Current gen but no usable op: nothing to act on.
  assert.deepEqual(parseScreenRpcMessage({ __pluginScreen: 1, callId: 1 }, 1), { kind: 'ignore' });
  assert.deepEqual(parseScreenRpcMessage({ __pluginScreen: 1, callId: 1, op: '' }, 1), {
    kind: 'ignore',
  });
});

// ---- nav → screen resolution ----

test('pluginNavScreen resolves only a declared screen referenced by the nav entry', () => {
  const screens = [{ id: 'home', title: 'Home', entry: 'ui/index.html', files: ['ui/index.html'] }];
  const ui = {
    nav: [
      { id: 'with', screen: 'home' },
      { id: 'without' },
      { id: 'dangling', screen: 'ghost' },
    ],
    screens,
  };
  assert.equal(pluginNavScreen(ui, 'with'), screens[0]);
  assert.equal(pluginNavScreen(ui, 'without'), null);
  assert.equal(pluginNavScreen(ui, 'dangling'), null);
  assert.equal(pluginNavScreen(ui, 'missing-nav'), null);
  assert.equal(pluginNavScreen(undefined, 'with'), null);
});

// ---- events filter ----

test('event subscription names must be a subset of the declared events', () => {
  const declared = ['aokie.call.incoming', 'aokie.call.ended'];
  assert.deepEqual(resolveEventSubscriptionNames(declared, undefined), {
    ok: true,
    names: declared,
  });
  assert.deepEqual(resolveEventSubscriptionNames(declared, ['aokie.call.ended', 'aokie.call.ended']), {
    ok: true,
    names: ['aokie.call.ended'],
  });
  assert.equal(resolveEventSubscriptionNames(declared, ['aokie.sms.sent']).ok, false);
  assert.equal(resolveEventSubscriptionNames(declared, 'aokie.call.ended').ok, false);
  assert.equal(resolveEventSubscriptionNames(declared, []).ok, false);
  assert.equal(resolveEventSubscriptionNames([], undefined).ok, false);
});
