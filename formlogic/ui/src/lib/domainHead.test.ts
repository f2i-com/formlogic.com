// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://outerstead.example/"}
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nameDomainPage, restorePlatformHead, showsAppAt } from './domainHead';
import { rememberedHost, type LaunchConfig } from './domainLaunchApi';

const HOST = 'outerstead.example';
const ui = resolve(__dirname, '../..');
const boot = readFileSync(resolve(ui, 'public/domain-head.js'), 'utf8');
const indexHtml = readFileSync(resolve(ui, 'index.html'), 'utf8');
// The page's head as the build sends it: index.html's own, and the manifest link the PWA plugin adds.
const HEAD = (indexHtml.match(/<head>([\s\S]*)<\/head>/)?.[1] ?? '') + '<link rel="manifest" href="/manifest.webmanifest">';
const SITE = {
  title: 'FormLogic — Build the system that runs your business',
  apple: 'FormLogic',
  theme: '#6366f1',
  manifest: '/manifest.webmanifest',
};

const config = (more: Partial<LaunchConfig> & { mode?: string } = {}): LaunchConfig => {
  const { mode = 'runtime_direct', ...rest } = more;
  return {
    app: { slug: 'outerstead', name: 'Outerstead', description: 'From the launch config', theme: { primaryColor: '#000000' } },
    domain: { domain: HOST, mode },
    landing: { headline: 'Outerstead', showOpenWebApp: true, showInstallPwa: true, showInstallNative: false, showPoweredBy: true },
    platformUrl: 'https://forms.example',
    ...rest,
  } as LaunchConfig;
};

const head = () => ({
  title: document.title,
  description: document.head.querySelector('meta[name="description"]')?.getAttribute('content'),
  apple: document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
  theme: document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  manifest: document.head.querySelector('link[rel="manifest"]')?.getAttribute('href'),
});
const siteDescription = () => (HEAD.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '').replace(/&amp;/g, '&');
const visit = (path: string) => window.history.replaceState(null, '', path);
const runBoot = () => new Function(boot)();
const remember = (value: unknown) => localStorage.setItem(`formlogic:domain-host:${HOST}`, typeof value === 'string' ? value : JSON.stringify(value));

describe('the head on a domain whose app opens there', () => {
  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = HEAD;
    visit('/');
  });
  afterEach(() => localStorage.clear());

  it('starts from the head the page is built with', () => {
    expect(head()).toEqual({ ...SITE, description: siteDescription() });
    // In the head, after every element it names, before any stylesheet or other script, which it
    // would wait for or which would run first.
    const top = indexHtml.slice(0, indexHtml.indexOf('</head>'));
    const at = top.indexOf('<script src="/domain-head.js"></script>');
    expect(at).toBeGreaterThan(0);
    for (const named of ['<title>', 'name="description"', 'name="apple-mobile-web-app-title"', 'name="theme-color"']) expect(top.indexOf(named)).toBeLessThan(at);
    expect(top.slice(0, at)).not.toMatch(/<script|rel="stylesheet"/);
  });

  it('names the manifest the build adds after it, once the page has been read', () => {
    remember({ config: config(), softnAccess: 'application' });
    document.head.innerHTML = HEAD.replace('<link rel="manifest" href="/manifest.webmanifest">', '');
    runBoot();
    expect(head().title).toBe('Outerstead');
    document.head.insertAdjacentHTML('beforeend', '<link rel="manifest" href="/manifest.webmanifest">');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(head().manifest).toBe('/manifest.json');
    restorePlatformHead();
    expect(head().manifest).toBe(SITE.manifest);
    // Named by the page first: left to it.
    document.head.innerHTML = HEAD.replace('<link rel="manifest" href="/manifest.webmanifest">', '');
    runBoot();
    document.head.insertAdjacentHTML('beforeend', '<link rel="manifest" href="/manifest.json">');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.head.querySelector('link[rel="manifest"]')?.hasAttribute('data-fl-original')).toBe(false);
  });


  it('decides where the app shows exactly as the router does', () => {
    const records: Array<[string, unknown]> = [
      ['opens at the root', { config: config(), softnAccess: 'application' }],
      ['members only', { config: config(), softnAccess: 'members' }],
      ['opens on a launch page', { config: config({ mode: 'launch_page' }), softnAccess: 'application' }],
      ['FormLogic signs in here', { config: config({ platformUrl: null }), softnAccess: 'application' }],
      ['FormLogic at this very address', { config: config({ platformUrl: `https://${HOST}` }), softnAccess: 'application' }],
      ['without its kind of app', { config: config() }],
      ['an address that is not a web one', { config: config({ platformUrl: 'javascript:alert(1)' }), softnAccess: 'application' }],
      ['the site', 'platform'],
      ['no domain', 'not-domain'],
      ['the word an older version kept', 'domain'],
      ['unreadable', '{"config":'],
    ];
    const paths = ['/', '/dashboard', '/app/outerstead', '/privacy', '/terms/', '/LOGIN', '/signup', '/forgot-password', '/reset-password', '/accept-invite', '/form/abc', '/sign-in/complete'];
    let applied = 0;
    for (const [label, record] of records) {
      for (const path of paths) {
        localStorage.clear();
        remember(record);
        document.head.innerHTML = HEAD;
        visit(path);
        runBoot();
        const remembered = rememberedHost(HOST);
        const known = remembered?.kind === 'domain' ? remembered : null;
        const router = showsAppAt({ config: known?.config, softnAccess: known?.softnAccess, host: HOST, pathname: path, origin: window.location.origin });
        expect(document.title === 'Outerstead', `${label} at ${path}`).toBe(router);
        if (router) applied += 1;
      }
    }
    // The table reaches both answers.
    expect(applied).toBeGreaterThan(10);
  });

  it("names the app with what this browser last saw of it, and leaves the site's own values kept", () => {
    remember({ config: config(), softnAccess: 'application' });
    localStorage.setItem('formlogic:app-look:v1:outerstead', JSON.stringify({ version: 'abc123', description: 'From the look', themeColor: '#102030', icon: 'svg' }));
    runBoot();
    expect(head()).toEqual({ title: 'Outerstead', description: 'From the look', apple: 'Outerstead', theme: '#102030', manifest: '/manifest.json' });
    expect(document.head.querySelector('title')?.getAttribute('data-fl-original')).toBe(SITE.title);
    // Without a look: the launch config's description, and the site's theme colour.
    document.head.innerHTML = HEAD;
    localStorage.removeItem('formlogic:app-look:v1:outerstead');
    runBoot();
    expect(head()).toEqual({ title: 'Outerstead', description: 'From the launch config', apple: 'Outerstead', theme: SITE.theme, manifest: '/manifest.json' });
  });

  it('writes a name as text, never markup', () => {
    remember({ config: { ...config(), app: { ...config().app, name: '</title><script>alert(1)</script>' } }, softnAccess: 'application' });
    const scripts = document.querySelectorAll('script').length;
    runBoot();
    expect(document.title).toBe('</title><script>alert(1)</script>');
    expect(document.querySelectorAll('script').length).toBe(scripts);
  });

  it("puts the site's own back on a page that isn't the app's, unless that page has named itself since", () => {
    remember({ config: config(), softnAccess: 'application' });
    runBoot();
    restorePlatformHead();
    expect(head()).toEqual({ ...SITE, description: siteDescription() });
    expect(document.head.querySelectorAll('[data-fl-applied]')).toHaveLength(0);

    document.head.innerHTML = HEAD;
    runBoot();
    document.title = 'Privacy · FormLogic';
    restorePlatformHead();
    expect(document.title).toBe('Privacy · FormLogic');
    expect(head().manifest).toBe(SITE.manifest);
  });

  it("keeps what the backend wrote: the site's values, and the app's name", () => {
    // AppLookController::withAppHead, for the root of the domain on a first visit.
    document.head.innerHTML = HEAD
      .replace(/<title>[^<]*<\/title>/, `<title data-fl-original="${SITE.title}" data-fl-applied="Outerstead">Outerstead</title>`)
      .replace('<link rel="manifest" href="/manifest.webmanifest">', '<link rel="manifest" href="/manifest.json" data-fl-original="/manifest.webmanifest" data-fl-applied="/manifest.json">');
    remember({ config: { ...config(), app: { ...config().app, name: 'Old name' } }, softnAccess: 'application' });
    runBoot();
    expect(head().title).toBe('Outerstead');
    expect(document.head.querySelector('title')?.getAttribute('data-fl-original')).toBe(SITE.title);
    restorePlatformHead();
    expect(head().title).toBe(SITE.title);
    expect(head().manifest).toBe(SITE.manifest);
  });

  it('names the app once the answer comes, where nothing named it before', () => {
    runBoot(); // nothing remembered: it only keeps the site's values
    expect(head().title).toBe(SITE.title);
    nameDomainPage({ name: 'Outerstead', description: 'From the launch config' });
    expect(head()).toMatchObject({ title: 'Outerstead', apple: 'Outerstead', description: 'From the launch config' });
    // Already named (here by the app itself): left as it is.
    document.title = 'Outerstead — Sol 3';
    nameDomainPage({ name: 'Outerstead' });
    expect(document.title).toBe('Outerstead — Sol 3');
    restorePlatformHead();
    expect(head().description).toBe(siteDescription());

    // Where the script never ran, nothing is known to be the site's: nothing changes.
    document.head.innerHTML = HEAD;
    nameDomainPage({ name: 'Outerstead' });
    expect(head().title).toBe(SITE.title);
  });
});
