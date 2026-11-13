// @vitest-environment jsdom
// The other sites a hosted JavaScript app may reach: its owner names each one, as a site's address
// and nothing more, and the list is what the app's pages are then served under.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteOutsidePanel } from './SiteOutsidePanel';
import { SITE_OUTSIDE, SITE_OUTSIDE_LENGTH, SITE_OUTSIDE_MOST, outsideSiteIsOwn, readOutsideSite, siteOutsideOf, withOutsideSites } from '../../lib/siteApps';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); });

async function render(sites: string[], onChange = vi.fn(), disabled = false) {
  root = createRoot(container);
  await act(async () => root!.render(<SiteOutsidePanel sites={sites} onChange={onChange} disabled={disabled} />));
  return onChange;
}
const field = () => container.querySelector<HTMLInputElement>('#site-outside-add')!;
const allow = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Allow this site'))!;
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(field(), text); field().dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('an outside site, as it is read and kept', () => {
  it('is the rule the server holds the list to (SecurityHeadersMiddleware::SITE_OUTSIDE)', () => {
    const php = readFileSync(resolve(__dirname, '../../../../backend/src/Middleware/SecurityHeadersMiddleware.php'), 'utf8');
    const rule = /public const SITE_OUTSIDE = '~(.+)~D';/.exec(php)?.[1];
    expect(rule?.replace(/\//g, '\\/')).toBe(SITE_OUTSIDE.source);
    expect(Number(/public const SITE_OUTSIDE_MOST = (\d+);/.exec(php)?.[1])).toBe(SITE_OUTSIDE_MOST);
    expect(Number(/public const SITE_OUTSIDE_LENGTH = (\d+);/.exec(php)?.[1])).toBe(SITE_OUTSIDE_LENGTH);
  });

  it('takes a name and never a number: no IP address, the visitor’s own machine and network among them', () => {
    for (const no of ['https://127.0.0.1', '192.168.1.10:8443', 'wss://10.0.0.5', 'https://203.0.113.5', 'https://0x7f.0.0.1', 'https://127.1', 'https://example.123', 'https://[::1]', 'https://*.com']) {
      expect(readOutsideSite(no), no).toBeNull();
    }
    // A name with numbers in it is a name.
    expect(readOutsideSite('https://cdn2.example.com')).toBe('https://cdn2.example.com');
    expect(readOutsideSite('https://xn--80ak6aa92e.com')).toBe('https://xn--80ak6aa92e.com');
    // And nothing longer than the server would take.
    expect(readOutsideSite(`https://${'a.'.repeat(140)}example.com`)).toBeNull();
  });

  it('knows this site’s own name, on any port, starred, or under a starred name above it', () => {
    // Found by review, 2026-11-13: a starred name above this site covered it and was let through.
    for (const own of ['https://apps.example.test', 'wss://apps.example.test', 'https://apps.example.test:8443', 'https://*.apps.example.test', 'https://*.example.test', ' HTTPS://Apps.Example.Test ']) {
      expect(outsideSiteIsOwn(own, 'apps.example.test'), own).toBe(true);
    }
    expect(outsideSiteIsOwn('https://*.example.test', 'forms.apps.example.test:8443')).toBe(true);
    for (const other of ['https://api.example.test', 'https://*.cdn.example.test', 'https://xapps.example.test', 'https://example.test', 'https://api.example.com']) {
      expect(outsideSiteIsOwn(other, 'apps.example.test'), other).toBe(false);
    }
    expect(outsideSiteIsOwn('https://api.example.com', '')).toBe(false);
  });

  it('cuts a pasted address down to its site, and takes a bare name as https', () => {
    expect(readOutsideSite('https://fonts.example.com/css2?family=Inter#x')).toBe('https://fonts.example.com');
    expect(readOutsideSite('  API.Example.com  ')).toBe('https://api.example.com');
    expect(readOutsideSite('wss://live.example.com:8443/socket')).toBe('wss://live.example.com:8443');
    expect(readOutsideSite('https://*.cdn.example.net')).toBe('https://*.cdn.example.net');
    // Not a site: plain http, a name with no dot, a bare star, another scheme, nothing.
    for (const no of ['http://plain.example.com', 'localhost', 'https://*', 'ftp://files.example.com', 'data:text/plain,x', '', '   ', 'https://a b.example.com', 'https://x.example.com;script-src *']) {
      expect(readOutsideSite(no), no).toBeNull();
    }
  });

  it('reads the list from the manifest and writes it back beside what else the manifest holds', () => {
    const project = { version: 3, access: 'members' as const, home: true, assets: {}, files: { 'manifest.json': JSON.stringify({ name: 'Shop', site: { entry: 'index.html' }, server: { entry: 'server/main.logic' } }) } };
    expect(siteOutsideOf(project)).toEqual([]);
    const allowed = withOutsideSites(project, ['https://api.example.com', 'wss://live.example.com']);
    expect(JSON.parse(allowed.files['manifest.json'])).toEqual({ name: 'Shop', site: { entry: 'index.html', outside: ['https://api.example.com', 'wss://live.example.com'] }, server: { entry: 'server/main.logic' } });
    expect(siteOutsideOf(allowed)).toEqual(['https://api.example.com', 'wss://live.example.com']);
    expect(allowed.version).toBe(3);
    // An empty list takes the key away rather than leaving an empty one.
    expect(JSON.parse(withOutsideSites(allowed, []).files['manifest.json']).site).toEqual({ entry: 'index.html' });
    // What the server would not take is not shown as allowed.
    expect(siteOutsideOf({ files: { 'manifest.json': JSON.stringify({ site: { entry: 'index.html', outside: ['https://ok.example.com', 'http://plain.example.com', 7, 'https://ok.example.com'] } }) } })).toEqual(['https://ok.example.com']);
    expect(siteOutsideOf({ files: { 'manifest.json': 'not json' } })).toEqual([]);
    // As the server reads one written by hand or by another program: in lower case, trimmed, once.
    // Found by review, 2026-11-13: these were allowed by the policy and shown here as not allowed,
    // and the next change made in the panel then wrote the list without them.
    const byHand = { files: { 'manifest.json': JSON.stringify({ site: { entry: 'index.html', outside: ['HTTPS://API.Example.com', '  wss://live.example.com ', 'https://api.example.com', 'https://127.0.0.1'] } }) } };
    expect(siteOutsideOf(byHand)).toEqual(['https://api.example.com', 'wss://live.example.com']);
  });
});

describe('SiteOutsidePanel', () => {
  it('says that nothing is allowed until a site is named, and adds the site typed', async () => {
    const onChange = await render([]);
    expect(container.textContent).toContain('No outside site is allowed.');
    expect(allow().disabled).toBe(true);
    await type('https://api.example.com/v1/items');
    await act(async () => allow().click());
    expect(onChange).toHaveBeenCalledWith(['https://api.example.com']);
    expect(field().value).toBe('');
  });

  it('lists the sites allowed, removes one, and takes Enter as Allow', async () => {
    const onChange = await render(['https://api.example.com', 'wss://live.example.com']);
    expect([...container.querySelectorAll('li')].map(item => item.textContent)).toEqual(['https://api.example.com', 'wss://live.example.com']);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove https://api.example.com"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith(['wss://live.example.com']);
    await type('fonts.example.com');
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onChange).toHaveBeenLastCalledWith(['https://api.example.com', 'wss://live.example.com', 'https://fonts.example.com']);
  });

  it('says why something typed is not taken, and adds nothing', async () => {
    const onChange = await render(['https://api.example.com']);
    await type('http://plain.example.com');
    await act(async () => allow().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('That is not a site’s address.');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    await type('https://API.example.com/again');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => allow().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('https://api.example.com is already on the list.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not take this site’s own address, and says so of one already on the list', async () => {
    const onChange = vi.fn();
    root = createRoot(container);
    await act(async () => root!.render(<SiteOutsidePanel sites={['https://api.example.com', 'https://*.example.test']} onChange={onChange} ownHost="apps.example.test" />));
    // One written into the manifest somewhere else: listed, and marked as never allowed.
    const rows = [...container.querySelectorAll('li')].map(item => item.textContent);
    expect(rows[0]).toBe('https://api.example.com');
    expect(rows[1]).toContain('https://*.example.test');
    expect(rows[1]).toContain('This site’s own address is never allowed.');
    for (const own of ['https://apps.example.test/api/apps', 'apps.example.test:8443', 'wss://*.apps.example.test']) {
      await type(own);
      await act(async () => allow().click());
      expect(container.querySelector('[role="alert"]')?.textContent, own).toContain('this site’s own address');
    }
    await type('127.0.0.1:8080');
    await act(async () => allow().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('number addresses');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes no more than an app may name, and nothing while it is not the owner’s to change', async () => {
    const many = Array.from({ length: SITE_OUTSIDE_MOST }, (_, index) => `https://s${index}.example.com`);
    await render(many);
    expect(field().disabled).toBe(true);
    expect(container.textContent).toContain(`An app may name up to ${SITE_OUTSIDE_MOST} sites.`);
    await act(async () => root?.unmount());
    await render(['https://api.example.com'], vi.fn(), true);
    expect(field().disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove https://api.example.com"]')!.disabled).toBe(true);
  });
});
