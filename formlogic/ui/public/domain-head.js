// FormLogic: the page's head on a customer's domain whose SoftN app opens there, before the page's
// own scripts (see src/lib/domainHead.ts, which this follows). A plain file, as the page's policy
// runs no inline script. It keeps the site's own value of each element it may change
// (data-fl-original), and where this browser has seen the domain show its app at this path, names
// the app there (data-fl-applied): a reload, a page from the service worker's copy, or an installed
// app opening, has the app's name in the tab from the start. Anything it can't read, it leaves.
(function () {
  'use strict';
  var ORIGINAL = 'data-fl-original';
  var APPLIED = 'data-fl-applied';
  var HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  try {
    var head = document.head;
    if (!head) return;
    var valueOf = function (element) {
      return element.tagName === 'TITLE' ? element.textContent || '' : element.getAttribute(element.tagName === 'LINK' ? 'href' : 'content');
    };
    var slots = {
      title: head.querySelector('title'),
      description: head.querySelector('meta[name="description"]'),
      appleTitle: head.querySelector('meta[name="apple-mobile-web-app-title"]'),
      themeColor: head.querySelector('meta[name="theme-color"]')
    };
    // The site's own values, unless the page came with them kept (the backend's root page).
    var keep = function (slot) {
      if (slot && !slot.hasAttribute(ORIGINAL)) slot.setAttribute(ORIGINAL, valueOf(slot) || '');
    };
    for (var key in slots) keep(slots[key]);
    // The manifest link the build adds comes after this script: it is named once the page is read,
    // unless the page has named it by then (DomainLaunchRouter), and kept as the site's.
    var manifest = '';
    var nameManifest = function () {
      var link = head.querySelector('link[rel="manifest"]');
      if (!link || (!link.hasAttribute(ORIGINAL) && valueOf(link) === '/manifest.json')) return;
      keep(link);
      name(link, manifest);
    };
    var name = function (slot, value) {
      if (!slot || !value || valueOf(slot) !== slot.getAttribute(ORIGINAL)) return;
      if (slot.tagName === 'TITLE') slot.textContent = value;
      else slot.setAttribute(slot.tagName === 'LINK' ? 'href' : 'content', value);
      slot.setAttribute(APPLIED, value);
    };
    if (head.querySelector('link[rel="manifest"]')) nameManifest();
    else document.addEventListener('DOMContentLoaded', nameManifest, { once: true });

    // The host, as the page takes it (App.tsx getLaunchHost): ?__flhost= only on a local host.
    var host = location.host.toLowerCase();
    if (/(^|\.)(localhost|local)$|^127\.0\.0\.1$/.test(location.hostname)) {
      var override = new URLSearchParams(location.search).get('__flhost');
      if (override) host = override.toLowerCase();
    }
    // What this browser last heard of the host (domainLaunchApi.ts rememberHost), held to the shape
    // the page will draw from (isStoredConfig).
    var stored = JSON.parse(localStorage.getItem('formlogic:domain-host:' + host) || 'null');
    if (!stored || typeof stored !== 'object' || !stored.softnAccess) return;
    var config = stored.config;
    var isAddress = function (value) {
      if (value === null || value === undefined) return true;
      try { return typeof value === 'string' && /^https?:$/.test(new URL(value, 'https://formlogic.invalid').protocol); } catch (e) { return false; }
    };
    if (!config || typeof config !== 'object' || !config.app || typeof config.app.slug !== 'string' || typeof config.app.name !== 'string' || !config.app.name
      || !config.domain || typeof config.domain.mode !== 'string' || !config.landing || typeof config.landing !== 'object'
      || ![config.platformUrl, config.landing.privacyUrl, config.landing.termsUrl, config.native && config.native.installUrl].every(isAddress)) return;

    // Where the page shows the app (domainHead.ts showsAppAt).
    var pathname = location.pathname;
    var path = pathname.toLowerCase().replace(/\/+$/, '');
    var signsInElsewhere = !!config.platformUrl && config.platformUrl !== location.origin;
    if (['/login', '/signup', '/forgot-password', '/reset-password', '/accept-invite', '/privacy', '/terms'].indexOf(path) >= 0) return;
    if (signsInElsewhere && path === '/sign-in/complete') return;
    if (typeof config.platformUrl === 'string' && config.platformUrl.slice(-(host.length + 2)) === '//' + host) return;
    if (path.indexOf('/form/') === 0) return;
    if (pathname === '/' && config.domain.mode !== 'runtime_direct') return;

    // The app's look as this browser last saw it (appLook.ts rememberedLook).
    var look = null;
    try { look = JSON.parse(localStorage.getItem('formlogic:app-look:v1:' + config.app.slug) || 'null'); } catch (e) { look = null; }
    if (!look || typeof look !== 'object' || typeof look.version !== 'string' || !/^[0-9a-f]{1,64}$/.test(look.version)) look = null;
    var description = look && typeof look.description === 'string' && look.description ? look.description.slice(0, 300)
      : typeof config.app.description === 'string' ? config.app.description : '';

    name(slots.title, config.app.name);
    name(slots.appleTitle, config.app.name);
    name(slots.description, description);
    name(slots.themeColor, look && typeof look.themeColor === 'string' && HEX.test(look.themeColor) ? look.themeColor : '');
    manifest = '/manifest.json';
    nameManifest();
  } catch (e) {
    // Storage blocked or unreadable: the page names the app itself, a moment later.
  }
})();
