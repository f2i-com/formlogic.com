import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginSnapshot } from './api.ts';
import {
  clampPollMs,
  displayValue,
  normalizeIcon,
  parsePluginSection,
  pluginNavEntries,
  pluginSectionId,
  resolvePath,
  snapshotBindingSource,
} from './pluginContributions.ts';

function snap(overrides: Partial<PluginSnapshot> = {}): PluginSnapshot {
  return {
    id: 'weather',
    name: 'Weather',
    version: '1.0.0',
    state: 'running',
    dir: 'C:/x',
    pluginApiVersion: 1,
    capabilities: [],
    connectors: [],
    events: [],
    pid: 1,
    startedAt: null,
    lastHealth: null,
    restartAttempts: 0,
    ...overrides,
  };
}

test('section id round-trips and only matches the plugin: prefix', () => {
  assert.equal(pluginSectionId('weather', 'home'), 'plugin:weather:home');
  assert.deepEqual(parsePluginSection('plugin:weather:home'), { pluginId: 'weather', navId: 'home' });
  assert.equal(parsePluginSection('services'), null);
  assert.equal(parsePluginSection('plugin:only-two'), null);
});

test('nav entries come only from installed, non-disabled plugins with ui', () => {
  const list: PluginSnapshot[] = [
    snap({ id: 'weather', ui: { nav: [{ id: 'home', label: 'Weather' }] } }),
    snap({ id: 'disabled', state: 'disabled', ui: { nav: [{ id: 'x', label: 'X' }] } }),
    snap({ id: 'nomanifest' }), // no ui
  ];
  const entries = pluginNavEntries(list);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pluginId, 'weather');
  assert.equal(entries[0].navId, 'home');
});

test('resolvePath honors safe dotted paths and rejects everything else', () => {
  const src = { health: { status: 'ok', detail: null }, n: 3 };
  assert.equal(resolvePath(src, '$health.status'), 'ok');
  assert.equal(resolvePath(src, 'n'), 3);
  assert.equal(resolvePath(src, 'health.missing'), undefined);
  // Unsafe segments never resolve (validator is the primary guard; this is defense-in-depth).
  assert.equal(resolvePath(src, 'health.status();evil'), undefined);
  assert.equal(resolvePath(src, ''), undefined);
});

test('snapshot binding source exposes state + health with an unknown fallback', () => {
  const withHealth = snapshotBindingSource(
    snap({ state: 'running', lastHealth: { at: 'now', ok: true, status: 'ok', detail: 'fine' } as PluginSnapshot['lastHealth'] }),
  );
  assert.equal(resolvePath(withHealth, '$state'), 'running');
  assert.equal(resolvePath(withHealth, '$health.status'), 'ok');
  const noHealth = snapshotBindingSource(snap({ lastHealth: null }));
  assert.equal(resolvePath(noHealth, '$health.status'), 'unknown');
});

test('display value bounds strings/objects and shows an em-dash for null', () => {
  assert.equal(displayValue(null), '—');
  assert.equal(displayValue('hi'), 'hi');
  assert.equal(displayValue(42), '42');
  assert.equal(displayValue('a'.repeat(300)).endsWith('…'), true);
});

test('icon normalizes to the allowlist and clamps poll interval', () => {
  assert.equal(normalizeIcon('phone'), 'phone');
  assert.equal(normalizeIcon('not-an-icon'), 'puzzle');
  assert.equal(normalizeIcon(undefined), 'puzzle');
  assert.equal(clampPollMs(100), 2000);
  assert.equal(clampPollMs(999999), 60000);
  assert.equal(clampPollMs(undefined), 5000);
});
