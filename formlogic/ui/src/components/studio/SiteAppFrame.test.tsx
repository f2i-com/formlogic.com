// @vitest-environment jsdom
// A hosted JavaScript app's frame: the server's own pages, sandboxed, and the one line this page
// gives them. Who is given the line (only the page that shows the server's proof), what may be
// asked over it (the app's backend, checked first; what the app keeps in the browser, held to a
// size), and that it is shut when the frame goes. The test plays the page in the frame, as
// backend/resources/site-boot.js does, over a real MessageChannel.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runNativeRequest: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { runNativeRequest: mocks.runNativeRequest } }));

import { SiteAppFrame, type SiteAppFrameProps, type SiteProblem } from './SiteAppFrame';
import { bumpSessionGeneration } from '../../lib/sessionGeneration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no MessageChannel; where the test environment gives none either, Node's is the real thing.
if (typeof globalThis.MessageChannel === 'undefined') (globalThis as { MessageChannel?: unknown }).MessageChannel = NodeMessageChannel;

type Reply = { id: number; ok: boolean; value?: { status: number; headers: Record<string, string>; body: string }; error?: string };
type Context = { app: unknown; user: unknown; backendOrigins: unknown; storage: Record<string, string>; route: string | null };

// As the descriptor names it: under the API's own base, which the frame joins it to.
const site = { url: '/app/notes/site/t1-abc/index.html', entry: 'index.html', proof: 'proof-one' };
// Kept under the app itself (its id), not under what its address is called.
const KEY = 'formlogic-site-storage:app-notes:member-a';
const JSON_HEADERS = { 'content-type': 'application/json' };
let root: Root | null = null;
let host: HTMLElement | null = null;
const problems: SiteProblem[] = [];
const opened: MessagePort[] = [];

const element = (props: Partial<SiteAppFrameProps> = {}) => (
  <SiteAppFrame slug="notes" appId="app-notes" name="Notes" version={3} site={site} backendOrigins={['https://api.example.com']} userId="member-a" onProblem={problem => problems.push(problem)} {...props} />
);
async function mount(props: Partial<SiteAppFrameProps> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(element(props)); });
}
const iframe = () => host!.querySelector('iframe')!;
const splash = () => host!.querySelector('[data-testid="app-splash"]');

/** Something says hello to this page. What this page posted to the frame in answer: nothing, or the line. */
function hello(data: unknown = { type: 'formlogic:site:hello', proof: site.proof }, source: Window | null = iframe().contentWindow) {
  const post = vi.spyOn(iframe().contentWindow!, 'postMessage').mockImplementation(() => undefined);
  act(() => { window.dispatchEvent(new MessageEvent('message', { source, data })); });
  const posted = post.mock.calls.map(call => call as unknown as [{ type: string; context: Context }, string, MessagePort[]]);
  post.mockRestore();
  return posted;
}
/** The app's page in the frame, once it has been given its line: what site-boot.js does with it. */
function open(proof = site.proof) {
  const posted = hello({ type: 'formlogic:site:hello', proof });
  expect(posted).toHaveLength(1);
  const [message, target, transfer] = posted[0];
  const port = transfer[0];
  opened.push(port);
  const waiting = new Map<number, (reply: Reply) => void>();
  let nextId = 1;
  port.onmessage = (event: MessageEvent) => {
    const reply = event.data as Reply;
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  };
  const ask = (payload: unknown) => new Promise<Reply>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    port.postMessage({ id, kind: 'backend', payload });
  });
  const tell = (kind: string, payload: unknown = {}) => port.postMessage({ id: 0, kind, payload });
  /** Everything said so far has been heard: a request that is refused at once is said last, and its answer waited for. */
  const heard = () => act(async () => { await ask({ method: 'TRACE', path: '/api/heard' }); });
  /** One request, answered. */
  const request = async (payload: unknown) => {
    let reply!: Reply;
    await act(async () => { reply = await ask(payload); });
    return reply;
  };
  return { message, target, port, context: message.context, ask, tell, heard, request };
}
const closed = (port: MessagePort) => new Promise<void>((resolve) => { port.addEventListener('close', () => resolve(), { once: true }); });
const kept = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, string> | null;

beforeEach(() => {
  mocks.runNativeRequest.mockReset();
  mocks.runNativeRequest.mockResolvedValue({ data: { result: { status: 200, body: { ok: true } } } });
  localStorage.clear();
  problems.length = 0;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host?.remove(); host = null;
  for (const port of opened.splice(0)) port.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the frame', () => {
  it('loads the server’s address in a sandbox with no origin and no way to move the window', async () => {
    await mount();
    const frame = iframe();
    expect(frame.getAttribute('src')).toBe(`/api${site.url}`);
    expect(frame.getAttribute('title')).toBe('Notes');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const tokens = frame.getAttribute('sandbox')!.split(' ');
    expect(tokens).toEqual(['allow-scripts', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-downloads', 'allow-pointer-lock']);
    expect(tokens).not.toContain('allow-same-origin');
    expect(tokens.filter(token => token.includes('top-navigation'))).toEqual([]);
  });

  it('shows the loading wheel until the app’s page says it is ready', async () => {
    await mount();
    expect(splash()?.getAttribute('aria-label')).toBe('Opening Notes');
    const app = open();
    await app.heard();
    expect(splash()).not.toBeNull();
    app.tell('ready');
    await app.heard();
    expect(splash()).toBeNull();
    expect(problems).toEqual([]);
  });

  it('uncovers the frame after twenty seconds whatever happened, so a refusal in it can be read', async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => { vi.advanceTimersByTime(19_999); });
    expect(splash()).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(splash()).toBeNull();
  });

  it('loads a new version afresh, and the page of the version before is not given a line', async () => {
    await mount();
    const first = iframe();
    const app = open();
    app.tell('ready');
    await app.heard();
    const shut = closed(app.port);
    const next = { url: '/app/notes/site/t2-def/index.html', entry: 'index.html', proof: 'proof-two' };
    await act(async () => { root!.render(element({ site: next, version: 4 })); });
    await shut;
    expect(iframe()).not.toBe(first);
    expect(iframe().getAttribute('src')).toBe(`/api${next.url}`);
    expect(splash()).not.toBeNull();
    expect(hello({ type: 'formlogic:site:hello', proof: site.proof })).toEqual([]);
    expect(open('proof-two').context.app).toEqual({ name: 'Notes', slug: 'notes', version: 4 });
  });

  it('opens afresh when the session changes: a frame opened for one sign-in is not answered in the next', async () => {
    await mount();
    const first = iframe();
    const app = open();
    const shut = closed(app.port);
    await act(async () => { bumpSessionGeneration(); });
    await shut;
    expect(iframe()).not.toBe(first);
  });
});

describe('the hello', () => {
  it('from anything but the frame, or without the server’s proof, gets nothing', async () => {
    await mount();
    expect(hello(undefined, window)).toEqual([]);
    expect(hello(undefined, null)).toEqual([]);
    expect(hello({ type: 'formlogic:site:hello', proof: 'a-guess' })).toEqual([]);
    expect(hello({ type: 'formlogic:site:hello' })).toEqual([]);
    expect(hello({ type: 'formlogic:site:hello', proof: '' })).toEqual([]);
    expect(hello({ type: 'formlogic:ready', proof: site.proof })).toEqual([]);
    expect(hello('formlogic:site:hello')).toEqual([]);
    expect(hello(null)).toEqual([]);
  });

  it('opens no line at all when the server sent no proof to compare with', async () => {
    await mount({ site: { ...site, proof: '' } });
    expect(hello({ type: 'formlogic:site:hello', proof: '' })).toEqual([]);
    expect(hello({ type: 'formlogic:site:hello' })).toEqual([]);
  });

  it('with the proof is given a line, and what the app is told about itself', async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark', visits: 3 }));
    await mount();
    const app = open();
    expect(app.message.type).toBe('formlogic:site:port');
    // The frame has no origin: no origin named here would be its own.
    expect(app.target).toBe('*');
    expect(app.context).toEqual({
      app: { name: 'Notes', slug: 'notes', version: 3 },
      user: { id: 'member-a' },
      backendOrigins: ['https://api.example.com'],
      // Text only: anything else found there is not the app's.
      storage: { theme: 'dark' },
      // Nowhere remembered for this tab yet.
      route: null,
    });
  });

  it('tells an app nobody is signed in to that nobody is, and keeps its storage apart', async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark' }));
    localStorage.setItem('formlogic-site-storage:app-notes:anyone', JSON.stringify({ seen: 'yes' }));
    await mount({ userId: null, backendOrigins: undefined });
    const app = open();
    expect(app.context).toEqual({ app: { name: 'Notes', slug: 'notes', version: 3 }, user: null, backendOrigins: [], storage: { seen: 'yes' }, route: null });
  });

  it('remembers where the app says the visitor is, and tells only the first page of a frame', async () => {
    sessionStorage.removeItem('formlogic-site-route:app-notes');
    await mount();
    const first = open();
    first.port.postMessage({ id: 0, kind: 'route', payload: { path: '/orders/12?tab=notes#top' } });
    // Not a path of the app's own: another site's address, and one far too long.
    first.port.postMessage({ id: 0, kind: 'route', payload: { path: '//evil.example/x' } });
    first.port.postMessage({ id: 0, kind: 'route', payload: { path: `/${'a'.repeat(3000)}` } });
    await vi.waitFor(() => expect(sessionStorage.getItem('formlogic-site-route:app-notes')).toBe('/orders/12?tab=notes#top'));
    // The app went to another of its pages itself: that is where it meant to go.
    expect(open().context.route).toBeNull();
    sessionStorage.removeItem('formlogic-site-route:app-notes');
  });

  it('starts the app where the page that shows it says, and tells that page where the visitor goes', async () => {
    sessionStorage.setItem('formlogic-site-route:app-notes', '/remembered');
    const onRoute = vi.fn();
    await mount({ initialRoute: '/orders/12', onRoute });
    const first = open();
    // The address the visitor opened comes before where this tab last had the app.
    expect(first.context.route).toBe('/orders/12');
    first.port.postMessage({ id: 0, kind: 'route', payload: { path: '/orders/13#notes' } });
    first.port.postMessage({ id: 0, kind: 'route', payload: { path: 'https://evil.example/' } });
    await vi.waitFor(() => expect(onRoute).toHaveBeenCalledTimes(1));
    expect(onRoute).toHaveBeenCalledWith('/orders/13#notes');
    sessionStorage.removeItem('formlogic-site-route:app-notes');
  });

  it('takes no place to start that is not a path of the app\'s own', async () => {
    sessionStorage.removeItem('formlogic-site-route:app-notes');
    await mount({ initialRoute: '//evil.example/x' });
    expect(open().context.route).toBeNull();
  });

  it('tells the owner, once, of an app that picks its screens from the address path', async () => {
    const onProblem = vi.fn();
    await mount({ onProblem });
    const app = open();
    app.port.postMessage({ id: 0, kind: 'routing', payload: { path: '/about', refused: false } });
    app.port.postMessage({ id: 0, kind: 'routing', payload: { path: '/about', refused: false } });
    await vi.waitFor(() => expect(onProblem).toHaveBeenCalledTimes(1));
    expect(onProblem.mock.calls[0][0]).toEqual({ kind: 'note', text: expect.stringMatching(/^This app picks its screens from the address path \(it went to \/about\)\. That works in this browser.+for Safari, use hash routing/) });
    // Where the browser refused the change (Safari), said as that.
    app.port.postMessage({ id: 0, kind: 'routing', payload: { path: '/orders', refused: true } });
    await vi.waitFor(() => expect(onProblem).toHaveBeenCalledTimes(2));
    expect(onProblem.mock.calls[1][0].text).toMatch(/^This browser did not let the app change its address to \/orders, so the app stayed on the screen it was on\./);
  });

  it('said again (the page loaded again) shuts the line before it and opens a new one', async () => {
    mocks.runNativeRequest.mockImplementation(() => new Promise(() => {}));
    await mount();
    const first = open();
    // Six in flight and one waiting, from the page that is about to go.
    for (let n = 0; n < 7; n++) void first.ask({ method: 'GET', path: `/api/old/${n}` });
    await first.heard();
    expect(mocks.runNativeRequest).toHaveBeenCalledTimes(6);
    const shut = closed(first.port);
    const second = open();
    await shut;
    expect(second.port).not.toBe(first.port);
    await second.heard();
    // The one that waited is not asked for: nobody waits for its answer.
    expect(mocks.runNativeRequest).toHaveBeenCalledTimes(6);
  });
});

describe('a request to the app’s backend', () => {
  it('reaches the server as the app asked it, with only the headers a backend is sent', async () => {
    mocks.runNativeRequest.mockResolvedValueOnce({ data: { result: { status: 201, body: { id: 7 } } } });
    await mount();
    const app = open();
    const reply = await app.request({
      method: 'post', path: '/api/items?page=2&q=green%20tea',
      headers: { Authorization: 'Bearer app-token', 'idempotency-key': 'k-1', cookie: 'session=1', 'x-formlogic-visitor': '1', 'content-type': 'application/json' },
      body: '{"name":"Ada"}',
    });
    expect(mocks.runNativeRequest).toHaveBeenCalledTimes(1);
    const [slug, input, signal] = mocks.runNativeRequest.mock.calls[0];
    expect(slug).toBe('notes');
    expect(input).toEqual({ path: '/api/items', query: { page: '2', q: 'green tea' }, method: 'POST', headers: { authorization: 'Bearer app-token', 'idempotency-key': 'k-1' }, body: { name: 'Ada' } });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(reply).toEqual({ id: 1, ok: true, value: { status: 201, headers: JSON_HEADERS, body: '{"id":7}' } });
  });

  it('answers with the backend’s text as it is, and sends no body with GET or DELETE', async () => {
    mocks.runNativeRequest.mockResolvedValueOnce({ data: { result: { status: 200, body: 'plain words' } } });
    await mount();
    const app = open();
    expect((await app.request({ method: 'GET', path: '/api/items', headers: {}, body: null })).value).toEqual({ status: 200, headers: JSON_HEADERS, body: 'plain words' });
    expect(mocks.runNativeRequest.mock.calls[0][1]).toEqual({ path: '/api/items', query: {}, method: 'GET', headers: {}, body: {} });
    await app.request({ method: 'DELETE', path: '/api/items/7', body: '{"why":"done"}' });
    expect(mocks.runNativeRequest.mock.calls[1][1]).toEqual({ path: '/api/items/7', query: {}, method: 'DELETE', headers: {}, body: {} });
    // A list is a JSON body too, and an empty body is none.
    await app.request({ method: 'PUT', path: '/api/items', body: '[1,2]' });
    expect(mocks.runNativeRequest.mock.calls[2][1]).toMatchObject({ method: 'PUT', body: [1, 2] });
    await app.request({ method: 'POST', path: '/api/items', body: '' });
    expect(mocks.runNativeRequest.mock.calls[3][1]).toMatchObject({ method: 'POST', body: {} });
  });

  it.each([
    ['a method the backend does not take', { method: 'PATCH', path: '/api/items' }, 405, '{"error":"The app backend takes GET, POST, PUT and DELETE."}'],
    ['no method', { path: '/api/items' }, 405, '{"error":"The app backend takes GET, POST, PUT and DELETE."}'],
    ['a path outside the app’s API', { method: 'GET', path: '/app/notes/native' }, 404, null],
    ['the API’s root alone', { method: 'GET', path: '/api/' }, 404, null],
    ['a path with a character an app route never has', { method: 'GET', path: '/api/items/a.b' }, 404, null],
    ['a path that climbs out of the API', { method: 'GET', path: '/api/../auth/me' }, 404, null],
    ['another site named as the path', { method: 'GET', path: '//evil.example/api/items' }, 404, null],
    ['another site with backslashes', { method: 'GET', path: '/\\evil.example/api/items' }, 404, null],
    ['a whole address', { method: 'GET', path: 'https://evil.example/api/items' }, 404, null],
    ['a path past 2,000 characters', { method: 'GET', path: `/api/${'a'.repeat(1996)}` }, 404, null],
    ['a path that is not text', { method: 'GET', path: 5 }, 404, null],
    ['a body past 2 MB', { method: 'POST', path: '/api/items', body: `"${'x'.repeat(2 * 1024 * 1024)}"` }, 413, null],
    ['a body that is not JSON', { method: 'POST', path: '/api/items', body: 'name=Ada' }, 415, '{"error":"The app backend takes a JSON body."}'],
    ['a JSON body that is neither an object nor a list', { method: 'PUT', path: '/api/items', body: '"words"' }, 415, '{"error":"The app backend takes a JSON body."}'],
    ['a JSON null', { method: 'POST', path: '/api/items', body: 'null' }, 415, '{"error":"The app backend takes a JSON body."}'],
    ['a body that is not text', { method: 'POST', path: '/api/items', body: { name: 'Ada' } }, 415, '{"error":"The app backend takes a JSON body."}'],
  ])('refuses %s with an answer, and asks the server nothing', async (_what, payload, status, body) => {
    await mount();
    const reply = await open().request(payload);
    expect(reply.ok).toBe(true);
    expect(reply.value?.status).toBe(status);
    expect(reply.value?.headers).toEqual(JSON_HEADERS);
    expect(typeof (JSON.parse(reply.value!.body) as { error?: unknown }).error).toBe('string');
    if (body !== null) expect(reply.value?.body).toBe(body);
    expect(mocks.runNativeRequest).not.toHaveBeenCalled();
  });

  it('takes a path of exactly 2,000 characters and a body of exactly 2 MB', async () => {
    await mount();
    const app = open();
    const path = `/api/${'a'.repeat(1995)}`;
    expect(path).toHaveLength(2000);
    expect((await app.request({ method: 'GET', path })).value?.status).toBe(200);
    const body = `["${'x'.repeat(2 * 1024 * 1024 - 4)}"]`;
    expect(body).toHaveLength(2 * 1024 * 1024);
    expect((await app.request({ method: 'POST', path: '/api/items', body })).value?.status).toBe(200);
    expect(mocks.runNativeRequest).toHaveBeenCalledTimes(2);
  });

  it('answers a refusal of the server’s with its status, not a failed request', async () => {
    await mount();
    const app = open();
    mocks.runNativeRequest.mockResolvedValueOnce({ error: 'App not found or access denied', status: 403 });
    expect(await app.request({ method: 'GET', path: '/api/items' })).toEqual({ id: 1, ok: true, value: { status: 403, headers: JSON_HEADERS, body: '{"error":"App not found or access denied"}' } });
    // No answer at all has no status of its own.
    mocks.runNativeRequest.mockResolvedValueOnce({ error: 'Network error', transportFailure: true });
    expect(await app.request({ method: 'GET', path: '/api/items' })).toEqual({ id: 2, ok: true, value: { status: 502, headers: JSON_HEADERS, body: '{"error":"Network error"}' } });
    // An answer that is not one.
    mocks.runNativeRequest.mockResolvedValueOnce({ data: {} });
    expect((await app.request({ method: 'GET', path: '/api/items' })).value?.status).toBe(502);
  });

  it('says a request that could not be made at all as one, as a fetch would', async () => {
    await mount();
    const app = open();
    mocks.runNativeRequest.mockRejectedValueOnce(new Error('The request could not be sent.'));
    expect(await app.request({ method: 'GET', path: '/api/items' })).toEqual({ id: 1, ok: false, error: 'The request could not be sent.' });
    // And the line still works.
    expect((await app.request({ method: 'GET', path: '/api/items' })).value?.status).toBe(200);
  });

  it('makes six at once and has a seventh wait its turn, not refused', async () => {
    const settle: Array<(value: unknown) => void> = [];
    mocks.runNativeRequest.mockImplementation(() => new Promise((resolve) => { settle.push(resolve); }));
    await mount();
    const app = open();
    const answers = Array.from({ length: 7 }, (_, n) => app.ask({ method: 'GET', path: `/api/items/${n}` }));
    await app.heard();
    expect(mocks.runNativeRequest).toHaveBeenCalledTimes(6);
    await act(async () => { settle[0]({ data: { result: { status: 200, body: { n: 0 } } } }); await answers[0]; });
    expect(mocks.runNativeRequest).toHaveBeenCalledTimes(7);
    expect(mocks.runNativeRequest.mock.calls[6][1]).toMatchObject({ path: '/api/items/6' });
    let replies: Reply[] = [];
    await act(async () => {
      for (const [n, done] of settle.entries()) if (n > 0) done({ data: { result: { status: 200, body: { n } } } });
      replies = await Promise.all(answers);
    });
    expect(replies.map(reply => reply.value?.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(replies[6].value?.body).toBe('{"n":6}');
  });

  it('tells a line of requests without end what a busy host says', async () => {
    mocks.runNativeRequest.mockImplementation(() => new Promise(() => {}));
    await mount();
    const app = open();
    // Six in flight, a hundred waiting, and one more.
    for (let n = 0; n < 106; n++) void app.ask({ method: 'GET', path: `/api/items/${n}` });
    const last = await app.request({ method: 'GET', path: '/api/items/last' });
    expect(last.value?.status).toBe(429);
    expect(JSON.parse(last.value!.body)).toMatchObject({ code: 'rate_limited' });
    expect(mocks.runNativeRequest).toHaveBeenCalledTimes(6);
  });

  it('ignores a request it could not answer', async () => {
    await mount();
    const app = open();
    for (const id of [0, -1, 1.5, 'one', null]) app.port.postMessage({ id, kind: 'backend', payload: { method: 'GET', path: '/api/items' } });
    await app.heard();
    expect(mocks.runNativeRequest).not.toHaveBeenCalled();
  });
});

describe('what the app keeps in the browser', () => {
  it('is kept for this app and person as it is set, removed and cleared, and given to the next page', async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark' }));
    await mount();
    const app = open();
    app.tell('storage:set', { key: 'token', value: 'abc' });
    app.tell('storage:set', { key: '__proto__', value: 'a name like any other' });
    await app.heard();
    expect(localStorage.getItem(KEY)).toBe('{"theme":"dark","token":"abc","__proto__":"a name like any other"}');
    app.tell('storage:remove', { key: 'theme' });
    app.tell('storage:remove', { key: '__proto__' });
    app.tell('storage:remove', { key: 'never-set' });
    await app.heard();
    expect(kept()).toEqual({ token: 'abc' });
    // What is not a name and text is not kept.
    app.tell('storage:set', { key: 'count', value: 3 });
    app.tell('storage:set', { key: 5, value: 'five' });
    app.tell('storage:set', 'token');
    await app.heard();
    expect(kept()).toEqual({ token: 'abc' });
    // The page loads again and starts with what was kept.
    const again = open();
    expect(again.context.storage).toEqual({ token: 'abc' });
    again.tell('storage:clear');
    await again.heard();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(open().context.storage).toEqual({});
    expect(problems).toEqual([]);
  });

  it('is held to 1 MB: a write past it is dropped, what was there stays, and it is said once', async () => {
    await mount();
    const app = open();
    const large = 'x'.repeat(1024 * 1024);
    app.tell('storage:set', { key: 'small', value: 'kept' });
    app.tell('storage:set', { key: 'large', value: large });
    app.tell('storage:set', { key: 'larger', value: large + large });
    await app.heard();
    expect(kept()).toEqual({ small: 'kept' });
    expect(problems).toEqual([{ kind: 'error', text: 'This app tried to keep more than 1 MB in this browser.' }]);
    // Under it, the app goes on keeping things, and may let go of what it has.
    app.tell('storage:set', { key: 'after', value: 'x'.repeat(900_000) });
    app.tell('storage:set', { key: 'small', value: 'x'.repeat(200_000) });
    app.tell('storage:remove', { key: 'small' });
    await app.heard();
    expect(Object.keys(kept()!)).toEqual(['after']);
    expect(problems).toHaveLength(1);
  });

  it('does not write over what the same app kept from another tab', async () => {
    await mount();
    const app = open();
    app.tell('storage:set', { key: 'here', value: '1' });
    await app.heard();
    // The other tab's page kept something too.
    localStorage.setItem(KEY, JSON.stringify({ here: '1', there: '2' }));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: KEY })); });
    app.tell('storage:set', { key: 'here', value: '3' });
    await app.heard();
    expect(kept()).toEqual({ here: '3', there: '2' });
  });

  it('goes on for this visit where the browser will not keep anything', async () => {
    localStorage.setItem(KEY, 'not json');
    await mount();
    const app = open();
    expect(app.context.storage).toEqual({});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('SecurityError'); });
    app.tell('storage:set', { key: 'draft', value: 'words' });
    await app.heard();
    expect(open().context.storage).toEqual({ draft: 'words' });
    const last = open();
    last.tell('storage:clear');
    await last.heard();
    expect(open().context.storage).toEqual({});
    expect(problems).toEqual([]);
  });
});

describe('what went wrong in the app', () => {
  it('reaches its owner: what the browser refused it, and its errors, each once', async () => {
    await mount();
    const app = open();
    const here = window.location.origin;
    app.tell('blocked', { what: 'script-src-elem', where: 'https://cdn.example.com' });
    app.tell('blocked', { what: 'script-src-elem', where: 'https://cdn.example.com' });
    app.tell('blocked', { what: 'connect-src', where: 'https://api.other.example/v1/items' });
    app.tell('blocked', { what: 'img-src', where: `${here}/assets/logo.png` });
    app.tell('blocked', { what: 'form-action', where: `${here}/api/app/notes/site/t1-abc/send` });
    app.tell('blocked', { what: 'frame-src', where: 'about' });
    app.tell('blocked', {});
    app.tell('error', { message: 'items is not defined' });
    app.tell('error', { message: 'items is not defined' });
    app.tell('error', { message: '   ' });
    app.tell('error', { message: 42 });
    await app.heard();
    expect(problems).toEqual([
      { kind: 'blocked', text: 'The browser stopped the app from loading https://cdn.example.com (outside sites are not reachable from a hosted app).' },
      { kind: 'blocked', text: 'The browser stopped the app from reaching https://api.other.example/v1/items (outside sites are not reachable from a hosted app).' },
      { kind: 'blocked', text: `The browser stopped the app from loading ${here}/assets/logo.png (a path that starts with / is this site's, not the app's: the app reaches its own files by relative paths).` },
      { kind: 'blocked', text: `The browser stopped the app from using ${here}/api/app/notes/site/t1-abc/send (form-action).` },
      { kind: 'blocked', text: 'The browser stopped the app from using about (frame-src).' },
      { kind: 'blocked', text: 'The browser stopped the app from using something it asked for.' },
      { kind: 'error', text: 'items is not defined' },
    ]);
  });

  it('uncovers the frame when the page failed before it was ready: the frame says why', async () => {
    await mount();
    const app = open();
    app.tell('error', { message: 'The app’s first page could not be read (404).' });
    await app.heard();
    expect(splash()).toBeNull();
    expect(problems).toEqual([{ kind: 'error', text: 'The app’s first page could not be read (404).' }]);
  });

  it('is not told without end by an app that fails in a loop', async () => {
    await mount();
    const app = open();
    for (let n = 0; n < 80; n++) app.tell('error', { message: `failure ${n}` });
    await app.heard();
    expect(problems).toHaveLength(50);
  });

  it('ignores what is not a message of the line’s', async () => {
    await mount();
    const app = open();
    for (const said of ['ready', null, 7, ['ready'], { kind: 'workspaceOpen', payload: { path: '/admin' } }, { id: 0 }, { kind: 5 }]) app.port.postMessage(said);
    await app.heard();
    expect(splash()).not.toBeNull();
    expect(problems).toEqual([]);
    expect(mocks.runNativeRequest).not.toHaveBeenCalled();
  });
});

describe('when the frame goes', () => {
  it('shuts the line, stops what was in flight, and hears no more hellos', async () => {
    mocks.runNativeRequest.mockImplementation(() => new Promise(() => {}));
    await mount();
    const frame = iframe();
    const inFrame = frame.contentWindow!;
    const app = open();
    void app.ask({ method: 'GET', path: '/api/slow' });
    await app.heard();
    const signal = mocks.runNativeRequest.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    const shut = closed(app.port);
    const post = vi.spyOn(inFrame, 'postMessage').mockImplementation(() => undefined);
    await act(async () => root!.unmount());
    root = null;
    await shut;
    expect(signal.aborted).toBe(true);
    window.dispatchEvent(new MessageEvent('message', { source: inFrame, data: { type: 'formlogic:site:hello', proof: site.proof } }));
    expect(post).not.toHaveBeenCalled();
  });
});
