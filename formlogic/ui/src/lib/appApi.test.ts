/**
 * The API section's words and checks (lib/appApi): routes read from a manifest as the app host
 * reads them, who may call each, a query and a body checked before Try it sends them, and an
 * answer, a status, a time and a caller as a person reads them.
 */
import { describe, expect, it } from 'vitest';
import { ANSWER_SHOWN, answerText, apiOf, BODY_LIMIT, callerInWords, checkBody, checkQuery, durationInWords, routeKey, routeWrites, statusInWords, statusTone, triable, whoMayCall } from './appApi';

const manifest = (server: unknown) => JSON.stringify({ name: 'Task board', main: 'index.html', server });

describe('the routes of an app', () => {
  it('reads each route as the app host serves it', () => {
    const api = apiOf(manifest({
      entry: 'server/main.logic',
      database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql', 'server/migrations/002.sql'] },
      routes: [
        { path: '/api/items', method: 'GET', handler: 'listItems', transaction: 'read', authorization: 'anonymous' },
        { path: '/api/items', method: 'POST', handler: 'createItem', transaction: 'write', authorization: 'anonymous' },
        // Undeclared: a read for a GET, a write otherwise, and for the app's own page.
        { path: '/api/items/done', method: 'POST', handler: 'setDone' },
        { path: '/api/stats', method: 'GET', handler: 'stats', transaction: 'none' },
      ],
    }))!;
    expect(api.routes.map(route => [routeKey(route), route.handler, route.transaction, route.authorization, route.unserved])).toEqual([
      ['GET /api/items', 'listItems', 'read', 'anonymous', null],
      ['POST /api/items', 'createItem', 'write', 'anonymous', null],
      ['POST /api/items/done', 'setDone', 'write', 'application', null],
      ['GET /api/stats', 'stats', 'read', 'application', null],
    ]);
    expect(api.migrations).toEqual(['server/migrations/001.sql', 'server/migrations/002.sql']);
    expect(api.database).toBe(true);
  });

  it('says why a route this server does not serve is not served', () => {
    const api = apiOf(manifest({ routes: [
      { path: '/admin/reset', method: 'POST', handler: 'reset' },
      { path: '/api/items', method: 'PATCH', handler: 'patch' },
      { path: '/api/backup', method: 'GET', handler: 'backup', authorization: 'host-token' },
      { path: '/api/items?all=1', method: 'GET', handler: 'all' },
    ] }))!;
    const address = 'This server routes addresses under /api/ made of letters, digits, hyphens, underscores and slashes.';
    expect(api.routes.map(route => route.unserved)).toEqual([
      address,
      'This server takes GET, POST, PUT and DELETE only.',
      'It asks for a host key, which this server does not hold.',
      address,
    ]);
    expect(whoMayCall(api.routes[2], 'application')).toBe('No one here');
  });

  it('has no backend to show for a manifest without a server block, or no manifest at all', () => {
    expect(apiOf(JSON.stringify({ name: 'Notes', main: 'index.html' }))).toBeNull();
    expect(apiOf('not json')).toBeNull();
    expect(apiOf(undefined)).toBeNull();
    expect(apiOf('[]')).toBeNull();
    // A server block with nothing in it yet, and entries that are not routes.
    expect(apiOf(manifest({ entry: 'server/main.logic', routes: [null, 'GET /x', { path: '/api/x' }] }))).toEqual({ routes: [], migrations: [], database: false });
  });

  it('asks before a route that can change the data, and only then', () => {
    expect(routeWrites({ method: 'GET', transaction: 'read' })).toBe(false);
    expect(routeWrites({ method: 'GET', transaction: 'write' })).toBe(true);
    expect(routeWrites({ method: 'POST', transaction: 'read' })).toBe(true);
    expect(routeWrites({ method: 'DELETE', transaction: 'write' })).toBe(true);
  });

  it('says who may call a route in the words Settings uses for who can use the app', () => {
    expect(whoMayCall({ unserved: null, siteOnly: false }, 'members')).toBe('Only people you invite');
    expect(whoMayCall({ unserved: null, siteOnly: false }, 'application')).toBe('Anyone with the link');
    expect(whoMayCall({ unserved: null, siteOnly: false }, undefined)).toBe('Only people you invite');
  });

  it('keeps the routes under /api/site/ to the site: listed as its own, never offered to Try it', () => {
    // App AI delivers its answers to /api/site/jobs/deliver; the server refuses any page that asks for it.
    const api = apiOf(manifest({ routes: [
      { path: '/api/site/jobs/deliver', method: 'POST', handler: 'deliver' },
      // (the server lowercases the address before it compares: NativeAppController)
      { path: '/api/Site/camera', method: 'POST', handler: 'camera' },
      { path: '/api/sites', method: 'GET', handler: 'sites' },
    ] }))!;
    expect(api.routes.map(route => [route.siteOnly, route.unserved, triable(route), whoMayCall(route, 'application')])).toEqual([
      [true, null, false, 'This site only'],
      [true, null, false, 'This site only'],
      [false, null, true, 'Anyone with the link'],
    ]);
  });
});

describe('a call checked before it is sent', () => {
  it('takes a query of names and text, as an address carries it', () => {
    expect(checkQuery('')).toEqual({ ok: true, value: {} });
    expect(checkQuery('  ')).toEqual({ ok: true, value: {} });
    expect(checkQuery('{"page": "2", "size": 50, "all": true}')).toEqual({ ok: true, value: { page: '2', size: '50', all: 'true' } });
    expect(checkQuery('{"tags": ["a"]}')).toEqual({ ok: false, error: 'In the query, "tags" is not text or a number: an address cannot carry a list or an object.' });
    expect(checkQuery('{"x": null}').ok).toBe(false);
    expect(checkQuery('[1, 2]')).toEqual({ ok: false, error: 'The query is a JSON object of names and values, such as {"page": "2"}.' });
    const broken = checkQuery('{page: 2}');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.error).toMatch(/^The query is not valid JSON/);
  });

  it('takes a body that is a JSON object or list, and nothing larger than the app takes', () => {
    expect(checkBody('')).toEqual({ ok: true, value: {} });
    expect(checkBody('{"title": "Buy milk", "done": 0}')).toEqual({ ok: true, value: { title: 'Buy milk', done: 0 } });
    expect(checkBody('[1, 2]')).toEqual({ ok: true, value: [1, 2] });
    for (const bare of ['"text"', '42', 'null', 'true']) expect(checkBody(bare)).toEqual({ ok: false, error: 'The body is a JSON object or list, such as {"title": "Buy milk"}.' });
    const broken = checkBody('{"title": "Buy milk",}');
    expect(!broken.ok && broken.error).toMatch(/^The body is not valid JSON/);
    expect(checkBody(JSON.stringify({ text: 'x'.repeat(BODY_LIMIT) }))).toEqual({ ok: false, error: 'The body is larger than the 2 MB the app takes in one call.' });
  });
});

describe('what came back, in words', () => {
  it('lays an answer out to read where it is JSON, and leaves text as it came', () => {
    expect(answerText({ items: [{ id: 1 }] })).toEqual({ text: '{\n  "items": [\n    {\n      "id": 1\n    }\n  ]\n}', json: true, cut: false });
    expect(answerText('{"ok":true}')).toEqual({ text: '{\n  "ok": true\n}', json: true, cut: false });
    expect(answerText('Service unavailable')).toEqual({ text: 'Service unavailable', json: false, cut: false });
    expect(answerText(undefined)).toEqual({ text: '', json: false, cut: false });
    expect(answerText(null)).toEqual({ text: 'null', json: true, cut: false });
    const long = answerText({ text: 'x'.repeat(ANSWER_SHOWN) });
    expect([long.text.length, long.cut]).toEqual([ANSWER_SHOWN, true]);
  });

  it('says a status, a time and who called as a person reads them', () => {
    expect([statusInWords(200), statusInWords(201), statusInWords(404), statusInWords(422), statusInWords(429), statusInWords(503), statusInWords(299)]).toEqual(['OK', 'Created', 'Not found', 'Not accepted', 'Too many calls', 'Unavailable', '']);
    expect([statusTone(204), statusTone(304), statusTone(422), statusTone(500)]).toEqual(['ok', 'redirect', 'refused', 'failed']);
    expect([durationInWords(0), durationInWords(42.4), durationInWords(999), durationInWords(1234), durationInWords(15_400), durationInWords(-1)]).toEqual(['0 ms', '42 ms', '999 ms', '1.2 s', '15 s', '']);
    expect([callerInWords('owner'), callerInWords('member'), callerInWords('visitor')]).toEqual(['You', 'A member', 'A visitor']);
  });
});
