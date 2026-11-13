// The first thing that runs in a hosted JavaScript app's frame (served by SiteAppController as the
// frame's document, before any of the app's own files).
//
// The app is someone's compiled front end. It runs in a sandbox with no origin of its own: it has
// no cookies, no storage and no network but its own files. That keeps it away from the platform
// and from every other app, and it also takes away things an ordinary build expects to be there.
// This script gives those back, each through the page that frames the app, which is the only
// party that knows who is signed in:
//   - fetch() and XMLHttpRequest to the app's own API (/api/…) reach the app's private backend;
//   - localStorage and sessionStorage work, and localStorage is kept for this person and app;
//   - document.cookie holds what is set for as long as the page is open, instead of throwing.
// And it makes the app's address look the way a build expects, since most are made to sit at the
// root of a site of their own:
//   - the page's address reads "/" (then whatever the app's router makes of it), so a router that
//     goes by the path finds its first screen;
//   - a file named from the root (/assets/app.js) or beside the page (assets/app.js) is the
//     app's own file, wherever the page's address has been moved to.
// Then it loads the app's real page into this same document, so the app's scripts start with all
// of that already in place. Nothing here trusts the app: every request is checked again by the
// framing page and by the server.
(() => {
  'use strict';
  const host = window.parent;
  if (!host || host === window) {
    // Opened by its address rather than inside its app's page: there is nobody to ask for anything.
    document.body.textContent = 'This app runs inside its own page on FormLogic. Open it from there.';
    return;
  }
  // What the server wrote on this script: the site's root (its address up to and including the
  // ticket), the page of the site this document is to become, and the proof to show the framing page.
  const told = document.currentScript;
  const base = new URL(document.baseURI);
  const origin = base.origin;
  const site = told?.getAttribute('data-root') || base.pathname.replace(/[^/]*$/, '');
  const page = told?.getAttribute('data-page') || 'index.html';
  const proof = told?.getAttribute('data-proof') || '';
  const waiting = new Map();
  let port = null;
  let nextId = 1;
  let context = { app: {}, user: null, backendOrigins: [], storage: {}, route: null };

  // ── The line to the framing page ─────────────────────────────────────────────────────────────
  const connected = new Promise((resolve) => {
    const hello = (event) => {
      if (event.source !== host || !event.data || event.data.type !== 'formlogic:site:port' || !event.ports || !event.ports[0]) return;
      window.removeEventListener('message', hello);
      port = event.ports[0];
      port.onmessage = (message) => {
        const answer = message.data || {};
        // The framing page asks whether this page is still the one in the frame (it cannot look).
        if (answer.ping) { port.postMessage({ id: 0, kind: 'pong', payload: { ping: answer.ping } }); return; }
        const asked = waiting.get(answer.id);
        if (!asked) return;
        waiting.delete(answer.id);
        if (answer.ok) asked.resolve(answer.value); else asked.reject(new Error(typeof answer.error === 'string' ? answer.error : 'The request could not be made.'));
      };
      context = Object.assign(context, event.data.context || {});
      resolve();
    };
    window.addEventListener('message', hello);
  });
  // The proof is what tells the framing page this document was served as the app's own: a page
  // someone navigated to inside the frame cannot say it, and is given nothing.
  host.postMessage({ type: 'formlogic:site:hello', proof }, '*');
  const ask = (kind, payload) => connected.then(() => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    port.postMessage({ id, kind, payload });
  }));
  const tell = (kind, payload) => { if (port) port.postMessage({ id: 0, kind, payload }); };

  // ── Addresses that start at the root ─────────────────────────────────────────────────────────
  // A build made for the root of a site names its files from there (/assets/app.js). Here the
  // root of the address is the platform's, so such an address is pointed at the app's own files.
  // Anything else (a file beside the page, another site, data:, blob:) is given back as it came.
  const own = (value) => {
    const text = typeof value === 'string' ? value : value instanceof URL ? value.href : null;
    if (text === null) return value;
    if (!(text.startsWith('/') && !text.startsWith('//')) && !text.startsWith(origin + '/')) return value;
    let url;
    try { url = new URL(text, origin); } catch { return value; }
    if (url.origin !== origin || url.pathname.startsWith(site)) return value;
    return origin + site + url.pathname.slice(1) + url.search + url.hash;
  };
  const ownSet = (value) => (typeof value === 'string'
    ? value.split(',').map((part) => { const [first, ...rest] = part.trim().split(/\s+/); return [own(first), ...rest].join(' '); }).join(', ')
    : value);

  // ── Which requests are the app's own API ─────────────────────────────────────────────────────
  // /api/… by an absolute path, api/… beside the app's files, or one of the addresses the app's
  // manifest names as its backend. Anything else is left to the browser, which lets through only
  // the app's own files.
  const apiPath = (input) => {
    let url;
    try { url = new URL(input, document.baseURI); } catch { return null; }
    if (url.origin === origin) {
      // The app's own files live under an address that itself starts with /api/ here, so they are
      // told apart first: everything under the site's root is a file, but for its api/ folder.
      if (url.pathname.startsWith(site)) return url.pathname.startsWith(site + 'api/') ? '/' + url.pathname.slice(site.length) + url.search : null;
      // The platform's own API is not the app's: only the app's routes are passed on, and the
      // server answers 404 for a path the app's backend does not have.
      return url.pathname === '/api' || url.pathname.startsWith('/api/') ? url.pathname + url.search : null;
    }
    return context.backendOrigins.includes(url.origin) ? url.pathname + url.search : null;
  };

  const headersOf = (headers) => {
    const out = {};
    if (!headers) return out;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) headers.forEach((value, name) => { out[name.toLowerCase()] = value; });
    else if (Array.isArray(headers)) for (const [name, value] of headers) out[String(name).toLowerCase()] = String(value);
    else for (const name of Object.keys(headers)) out[name.toLowerCase()] = String(headers[name]);
    return out;
  };
  const textOf = async (body) => {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      // A form without files is sent as JSON, which is what a backend handler reads. Files go
      // through the app's media, not through a request.
      const fields = {};
      for (const [name, value] of body.entries()) { if (typeof value !== 'string') throw new Error('Files cannot be sent to the app backend in a form.'); fields[name] = value; }
      return JSON.stringify(fields);
    }
    if (body instanceof Blob) return await body.text();
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return String(body);
  };
  /** One request to the app's backend: the answer as { status, headers, body } with a text body. */
  const backend = async (method, path, headers, body) => {
    const text = await textOf(body);
    return ask('backend', { method: String(method || 'GET').toUpperCase(), path, headers, body: text });
  };
  const answered = (answer) => {
    const status = Number(answer.status) || 500;
    // A status that may not carry a body is given none, or the Response cannot be made.
    const bare = status === 204 || status === 205 || status === 304;
    return new Response(bare ? null : (answer.body ?? ''), { status, headers: answer.headers || {} });
  };

  // ── fetch ────────────────────────────────────────────────────────────────────────────────────
  const browserFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const path = apiPath(request ? request.url : input);
    if (path === null) {
      // One of the app's files, or another site (which the browser refuses).
      if (!request) return browserFetch(own(input), init);
      const to = own(request.url);
      return browserFetch(to === request.url ? request : new Request(to, request), init);
    }
    const method = (init && init.method) || (request && request.method) || 'GET';
    const headers = Object.assign(request ? headersOf(request.headers) : {}, headersOf(init && init.headers));
    const body = init && 'body' in init ? init.body : request && method !== 'GET' && method !== 'HEAD' ? await request.clone().text() : null;
    let answer;
    try { answer = await backend(method, path, headers, body); } catch (error) { throw new TypeError(error.message); }
    return answered(answer);
  };

  // ── XMLHttpRequest (what axios and older code use) ───────────────────────────────────────────
  const BrowserXhr = window.XMLHttpRequest;
  class BridgedXhr extends EventTarget {
    constructor() {
      super();
      this.readyState = 0; this.status = 0; this.statusText = ''; this.response = null; this.responseText = '';
      this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false;
      this.upload = new EventTarget();
      this._real = null; this._headers = {}; this._answered = {}; this._aborted = false;
      for (const name of ['readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend', 'loadstart', 'progress']) this['on' + name] = null;
    }
    _fire(name) {
      const event = new Event(name);
      if (typeof this['on' + name] === 'function') { try { this['on' + name](event); } catch (error) { setTimeout(() => { throw error; }); } }
      this.dispatchEvent(event);
    }
    _state(state) { this.readyState = state; this._fire('readystatechange'); }
    open(method, url, async = true, user, password) {
      const path = apiPath(url);
      this._method = method; this._path = path; this._aborted = false;
      if (path === null) {
        // Not the app's API: a real request, which the browser holds to the app's own files.
        const real = new BrowserXhr();
        this._real = real;
        for (const name of ['readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend', 'loadstart', 'progress']) {
          real.addEventListener(name, () => {
            this.readyState = real.readyState; this.status = real.status; this.statusText = real.statusText; this.responseURL = real.responseURL;
            try { this.response = real.response; } catch { /* not ready */ }
            try { this.responseText = real.responseType === '' || real.responseType === 'text' ? real.responseText : ''; } catch { /* not text */ }
            this._fire(name);
          });
        }
        real.open(method, own(url), async, user, password);
        return;
      }
      this._real = null; this._headers = {}; this.responseURL = String(new URL(url, document.baseURI));
      this._state(1);
    }
    setRequestHeader(name, value) { if (this._real) this._real.setRequestHeader(name, value); else this._headers[String(name).toLowerCase()] = String(value); }
    getResponseHeader(name) { if (this._real) return this._real.getResponseHeader(name); const value = this._answered[String(name).toLowerCase()]; return value === undefined ? null : value; }
    getAllResponseHeaders() { if (this._real) return this._real.getAllResponseHeaders(); return Object.keys(this._answered).map((name) => `${name}: ${this._answered[name]}\r\n`).join(''); }
    overrideMimeType(type) { if (this._real) this._real.overrideMimeType(type); }
    abort() { if (this._real) { this._real.abort(); return; } this._aborted = true; if (this.readyState > 0 && this.readyState < 4) { this.readyState = 4; this._fire('abort'); this._fire('loadend'); } }
    send(body) {
      if (this._real) { this._real.responseType = this.responseType; this._real.timeout = this.timeout; this._real.withCredentials = this.withCredentials; this._real.send(body); return; }
      this._fire('loadstart');
      backend(this._method, this._path, this._headers, body).then((answer) => {
        if (this._aborted) return;
        this.status = Number(answer.status) || 500;
        this.statusText = '';
        this._answered = headersOf(answer.headers);
        const text = answer.body ?? '';
        this._state(2); this._state(3);
        if (this.responseType === 'json') { try { this.response = JSON.parse(text); } catch { this.response = null; } }
        else if (this.responseType === 'arraybuffer') this.response = new TextEncoder().encode(text).buffer;
        else if (this.responseType === 'blob') this.response = new Blob([text], { type: this._answered['content-type'] || '' });
        else { this.responseText = text; this.response = text; }
        this._state(4); this._fire('load'); this._fire('loadend');
      }, () => {
        if (this._aborted) return;
        this.status = 0; this._state(4); this._fire('error'); this._fire('loadend');
      });
    }
  }
  for (const [name, value] of [['UNSENT', 0], ['OPENED', 1], ['HEADERS_RECEIVED', 2], ['LOADING', 3], ['DONE', 4]]) { BridgedXhr[name] = value; BridgedXhr.prototype[name] = value; }
  window.XMLHttpRequest = BridgedXhr;

  // ── Files the page's own elements load ───────────────────────────────────────────────────────
  // A script, style, picture, sound or video named from the root is pointed at the app's own
  // files as it is set, so the browser never asks the platform for it. Each kind of element and
  // the attributes of it that load something:
  const LOADS = {
    SCRIPT: ['src'], LINK: ['href'], IMG: ['src', 'srcset'], SOURCE: ['src', 'srcset'], VIDEO: ['src', 'poster'], AUDIO: ['src'],
    TRACK: ['src'], EMBED: ['src'], INPUT: ['src'], IMAGE: ['href', 'xlink:href'], USE: ['href', 'xlink:href'],
  };
  const loadsOf = (element) => LOADS[String(element.tagName || '').toUpperCase()] || null;
  const mapped = (name, value) => (name === 'srcset' ? ownSet(value) : own(value));
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const names = loadsOf(this);
    return setAttribute.call(this, name, names && typeof value === 'string' && names.includes(String(name).toLowerCase()) ? mapped(String(name).toLowerCase(), value) : value);
  };
  const setAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (space, name, value) {
    const names = loadsOf(this);
    return setAttributeNS.call(this, space, name, names && typeof value === 'string' && names.includes(String(name).toLowerCase()) ? own(value) : value);
  };
  for (const [kind, names] of [['HTMLScriptElement', ['src']], ['HTMLLinkElement', ['href']], ['HTMLImageElement', ['src', 'srcset']], ['HTMLSourceElement', ['src', 'srcset']],
    ['HTMLMediaElement', ['src']], ['HTMLVideoElement', ['poster']], ['HTMLTrackElement', ['src']], ['HTMLEmbedElement', ['src']], ['HTMLInputElement', ['src']]]) {
    const proto = window[kind] && window[kind].prototype;
    for (const name of proto ? names : []) {
      const found = Object.getOwnPropertyDescriptor(proto, name);
      if (!found || !found.set || !found.configurable) continue;
      Object.defineProperty(proto, name, { ...found, set(value) { found.set.call(this, mapped(name, value)); } });
    }
  }
  // new Audio('/sound.mp3') names a file the same way.
  if (typeof window.Audio === 'function') {
    window.Audio = new Proxy(window.Audio, { construct: (target, given) => new target(...(given.length ? [own(given[0]), ...given.slice(1)] : [])) });
  }
  // new Worker('/assets/worker.js'). A browser starts a worker only from a file of the page's own
  // origin, and this page has none, so a worker named by its address is refused. One started
  // from a script the page made itself is allowed: so the worker is started from one line that
  // loads the app's file. Inside it the app's code runs as written; what it does not get is this
  // page's line to the backend (a worker's fetch('/api/…') is not answered).
  if (typeof window.Worker === 'function') {
    window.Worker = new Proxy(window.Worker, {
      construct: (target, given) => {
        const [from, options] = given;
        let file = null;
        try { file = new URL(String(own(from instanceof URL ? from.href : from)), document.baseURI).href; } catch { /* left to the browser */ }
        // One the page made (blob:, data:) is the browser's own to start.
        if (file === null || !/^https?:/i.test(file)) return new target(...given);
        const line = options && options.type === 'module' ? `import ${JSON.stringify(file)};` : `importScripts(${JSON.stringify(file)});`;
        const made = URL.createObjectURL(new Blob([line], { type: 'text/javascript' }));
        try { return new target(made, options); } finally { setTimeout(() => URL.revokeObjectURL(made), 60000); }
      },
    });
  }
  // What is put in the page as markup (innerHTML, a cloned template) sets nothing through the
  // above. It is corrected as it arrives; the browser has by then asked for the address at the
  // root and been refused, which is not reported as the app's fault (`repaired`).
  const repaired = new Set();
  const repair = (element) => {
    const names = loadsOf(element);
    for (const name of names || []) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      const to = mapped(name, value);
      if (to === value) continue;
      for (const part of name === 'srcset' ? value.split(',').map((one) => one.trim().split(/\s+/)[0]) : [value]) { try { repaired.add(new URL(part, origin).href); } catch { /* not an address */ } }
      setAttribute.call(element, name, to);
    }
  };
  const watcher = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') { repair(record.target); continue; }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        repair(node);
        for (const inner of node.querySelectorAll('[src],[href],[poster],[srcset]')) repair(inner);
      }
    }
  });

  // ── Storage ──────────────────────────────────────────────────────────────────────────────────
  // A sandboxed page has none: reading window.localStorage throws. The app is given one that is
  // read at once (it was sent with the page) and written through the framing page, which keeps
  // it for this person and this app and holds it to a size.
  const storageLike = (seed, kept) => {
    const values = new Map(Object.entries(seed || {}).map(([key, value]) => [key, String(value)]));
    const api = {
      get length() { return values.size; },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
      setItem: (key, value) => { values.set(String(key), String(value)); if (kept) tell('storage:set', { key: String(key), value: String(value) }); },
      removeItem: (key) => { values.delete(String(key)); if (kept) tell('storage:remove', { key: String(key) }); },
      clear: () => { values.clear(); if (kept) tell('storage:clear', {}); },
    };
    // Reading and writing as properties (localStorage.token = '…'), as the real one allows.
    return new Proxy(api, {
      get: (target, key) => (key in target ? target[key] : typeof key === 'string' ? target.getItem(key) ?? undefined : undefined),
      set: (target, key, value) => { if (key in target) return false; target.setItem(key, value); return true; },
      deleteProperty: (target, key) => { target.removeItem(key); return true; },
      has: (target, key) => key in target || values.has(String(key)),
      ownKeys: () => [...values.keys()],
      getOwnPropertyDescriptor: (target, key) => (values.has(String(key)) ? { value: values.get(String(key)), writable: true, enumerable: true, configurable: true } : undefined),
    });
  };
  const define = (object, name, value) => { try { Object.defineProperty(object, name, { configurable: true, enumerable: true, get: () => value }); } catch { /* the browser keeps its own */ } };

  // ── Cookies ──────────────────────────────────────────────────────────────────────────────────
  // document.cookie throws in a sandbox. What the app sets is kept while the page is open and is
  // never sent anywhere: a hosted app is told who is using it by its backend, not by a cookie.
  const jar = new Map();
  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      set: (text) => {
        const [pair, ...attributes] = String(text).split(';');
        const at = pair.indexOf('=');
        const name = (at < 0 ? pair : pair.slice(0, at)).trim();
        const value = at < 0 ? '' : pair.slice(at + 1).trim();
        if (!name) return;
        const gone = attributes.some((attribute) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(attribute) || (/^\s*expires\s*=/i.test(attribute) && Date.parse(attribute.split('=').slice(1).join('=')) < Date.now()));
        if (gone) jar.delete(name); else jar.set(name, value);
      },
    });
  } catch { /* the browser keeps its own */ }

  // ── The address the app sees ─────────────────────────────────────────────────────────────────
  // The app's page is served from a long address under the platform's API. A build expects to be
  // at the root of a site, and a router that goes by the path would find no screen for the long
  // one. So before the app starts, this page's address is rewritten to what it would be on a
  // site of the app's own: "/" for its first page, "/about.html" for another, or wherever the
  // framing page says the visitor was (`route`). It is the address of this frame only; nothing
  // is asked of the server by it, and the frame's files are still found by `own` and by the
  // <base> written into the page below. A browser that refuses the rewrite leaves the long
  // address in place, and the app then needs to pick its screens from the #hash.
  let rerouted = false;
  const asked = base.pathname.startsWith(site) ? base.pathname.slice(site.length) : '';
  const natural = '/' + asked.replace(/(^|\/)index\.html?$/i, '$1') + base.search + base.hash;
  const route = () => { tell('route', { path: rerouted ? location.pathname + location.search + location.hash : '/' + location.hash }); };
  // A page with no origin may not move to another site's address, and some browsers let it
  // change nothing but its #hash: a refused call is only remembered, so a router keeps running.
  const replaceReal = history.replaceState.bind(history);
  let goesByPath = false;
  for (const name of ['pushState', 'replaceState']) {
    const real = history[name].bind(history);
    history[name] = (state, title, url) => {
      const before = location.pathname;
      let refused = false;
      try { real(state, title, url); } catch { refused = true; try { real(state, title); } catch { /* nothing to keep */ } }
      // An app that picks its screens from the path is told to the framing page, once, for its
      // owner: it works where the browser allows the change and not where it refuses it, and a
      // built app's code no longer says which kind of router it has.
      if (!goesByPath && url !== undefined && url !== null) {
        let to = null;
        try { to = new URL(String(url), location.href); } catch { /* not an address */ }
        if (to && to.origin === location.origin && to.pathname !== before) { goesByPath = true; tell('routing', { path: to.pathname.slice(0, 200), refused }); }
      }
      route();
    };
  }

  // ── What the app can call itself ─────────────────────────────────────────────────────────────
  const formlogic = {
    /** A request to the app's own backend, whatever the path looks like: formlogic.fetch('/api/items'). */
    fetch: async (path, init = {}) => {
      const url = new URL(path, 'https://app.invalid');
      return answered(await backend(init.method || 'GET', url.pathname + url.search, headersOf(init.headers), init.body));
    },
    /** Who is using the app, when it is one only its members open: { id }, else null. */
    get user() { return context.user || null; },
    /** The app as it is installed: { name, slug, version }. */
    get app() { return context.app || {}; },
    /** The address of one of the app's own files, from its path in the build: formlogic.asset('img/logo.png'). */
    asset: (path) => origin + site + String(path).replace(/^\/+/, ''),
  };
  define(window, 'formlogic', Object.freeze(formlogic));

  // What this script listens for on the window. Opening the document to write the app's page
  // into it (below) clears every listener on the document and on the window, so these are put on
  // once now, for what goes wrong before the app's page is in, and again once it is open.
  const listen = () => {
    // What the browser refused the app (a script from another site, a request outside it) is told
    // to the framing page, which shows its owner why something did not load. An address this
    // script has since corrected is left out: the app's file did load.
    window.addEventListener('securitypolicyviolation', (event) => {
      const where = String(event.blockedURI || '');
      const what = event.effectiveDirective || event.violatedDirective || '';
      setTimeout(() => { if (!repaired.has(where)) tell('blocked', { what, where: where.slice(0, 300) }); }, 0);
    });
    window.addEventListener('error', (event) => { tell('error', { message: String(event.message || '').slice(0, 500) }); });
    window.addEventListener('unhandledrejection', (event) => { tell('error', { message: String((event.reason && event.reason.message) || event.reason || '').slice(0, 500) }); });
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);

    // Links the app did not handle itself (a router has already taken its own by now).
    window.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null;
      if (!link || link.hasAttribute('download')) return;
      const target = (link.getAttribute('target') || '').toLowerCase();
      if (target && target !== '_self') return;
      const href = link.getAttribute('href') || '';
      // To a place on this page. With the <base> below, the browser would read "#prices" as an
      // address under the app's files and load the app again.
      if (href.startsWith('#')) { event.preventDefault(); location.hash = href; return; }
      let to;
      try { to = new URL(href, document.baseURI); } catch { return; }
      if (!/^https?:$/.test(to.protocol)) return;
      // To another site: in a new tab. Followed in place it would put that site's page in the
      // app's frame, where the app's own page was; the frame may not move the whole window.
      if (to.origin !== origin) { event.preventDefault(); window.open(to.href, '_blank', 'noopener,noreferrer'); return; }
      // To a page of the app named from the root (/about.html): the app's own page of that name.
      if (!to.pathname.startsWith(site)) { event.preventDefault(); location.assign(own(to.href)); }
    });
  };
  listen();

  // ── The app itself ───────────────────────────────────────────────────────────────────────────
  // The page is read as it was uploaded and made ready: every file it names from the root is
  // pointed at the app's own files, and it is given a <base> so a file named beside the page is
  // found whatever the page's address has become. An import map does the same for a module the
  // app's scripts import from the root (import '/lib/x.js').
  const prepared = (html) => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const element of parsed.querySelectorAll('[src],[href],[poster],[srcset]')) repair(element);
    repaired.clear();
    const folder = origin + site + page.replace(/[^/]*$/, '');
    const named = parsed.querySelector('base[href]');
    if (named) {
      // The build names its own base (<base href="/">): the same place, among the app's files.
      let to = null;
      try { to = new URL(named.getAttribute('href'), origin + '/'); } catch { /* left as it is */ }
      if (to && to.origin === origin && !to.pathname.startsWith(site)) setAttribute.call(named, 'href', origin + site + to.pathname.slice(1));
    } else {
      const made = parsed.createElement('base');
      setAttribute.call(made, 'href', folder);
      parsed.head.prepend(made);
    }
    if (!parsed.querySelector('script[type="importmap" i]')) {
      const map = parsed.createElement('script');
      setAttribute.call(map, 'type', 'importmap');
      map.textContent = JSON.stringify({ imports: { [origin + site]: origin + site, [origin + '/']: origin + site } });
      (parsed.querySelector('base') || parsed.head.firstChild || parsed.head).after(map);
    }
    return (parsed.doctype ? new XMLSerializer().serializeToString(parsed.doctype) : '') + parsed.documentElement.outerHTML;
  };
  connected.then(async () => {
    define(window, 'localStorage', storageLike(context.storage, true));
    define(window, 'sessionStorage', storageLike({}, false));
    let html;
    try {
      const answer = await browserFetch(origin + site + page + '?formlogic-raw=1', { cache: 'no-store' });
      if (!answer.ok) throw new Error(`The app's page could not be read (${answer.status}).`);
      html = prepared(await answer.text());
    } catch (error) {
      document.body.textContent = error.message;
      tell('error', { message: error.message });
      return;
    }
    // Where the app starts: where the framing page says the visitor was, when this is the app's
    // first page, or else the page that was asked for.
    const start = natural === '/' && typeof context.route === 'string' && /^\/(?!\/)/.test(context.route) ? context.route : natural;
    try { replaceReal(null, '', start); } catch { /* this browser keeps the long address */ }
    rerouted = location.pathname !== base.pathname;
    tell('ready', { rerouted });
    route();
    document.open();
    listen();
    watcher.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster', 'srcset'] });
    document.write(html);
    document.close();
  });
})();
