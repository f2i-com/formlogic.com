// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The FormLogic Backups plugin's page (formlogic/oaiy-plugin/ui/backups), run against a stand-in
// for OAIY's PluginHost. It lives here because this is where the repository's browser tests run.
const folder = path.resolve(__dirname, '../../../oaiy-plugin/ui/backups');
const html = readFileSync(path.join(folder, 'index.html'), 'utf8');
const script = readFileSync(path.join(folder, 'backups.js'), 'utf8');

interface Call { name: string; payload: Record<string, unknown> }

const NOT_LINKED = { state: 'needs-link', detail: 'Not connected to FormLogic', linked: false, approved: false, nodeStatus: null, fingerprint: null, canAsk: true, hasKey: false, keyId: null, running: false, lastRun: null };
const READY = { ...NOT_LINKED, state: 'ready', detail: 'Ready', linked: true, approved: true, nodeStatus: 'approved', fingerprint: 'abcd 0123 abcd 0123 abcd 0123', hasKey: true, keyId: 'key-one' };
const NO_BACKUPS = { backups: [], total: 0, lastRun: null };

let calls: Call[] = [];
let answers: Record<string, (payload: Record<string, unknown>) => unknown> = {};
let timer: ReturnType<typeof setInterval>;

function start(status: unknown, more: typeof answers = {}) {
  calls = [];
  answers = {
    'status.get': () => status,
    'settings.get': () => ({ enabled: false, everyHours: 24, keep: 7 }),
    'link.get': () => ({ linked: true, server: 'https://forms.example.test', accountEmail: 'owner@example.test' }),
    'backups.list': () => NO_BACKUPS,
    'sources.list': () => ({ jobId: 'sources' }),
    'jobs.get': () => ({ state: 'done', result: { apps: [], forms: [] } }),
    ...more,
  };
  document.body.innerHTML = html;
  (window as unknown as { PluginHost: unknown }).PluginHost = {
    command: vi.fn(async (name: string, payload: Record<string, unknown>) => {
      calls.push({ name, payload });
      const answer = answers[name];
      if (!answer) throw new Error(`no command ${name}`);
      return answer(payload);
    }),
  };
  timer = setInterval(() => {}, 1000);
  new Function(script)();
}

const settle = async () => { for (let n = 0; n < 20; n += 1) await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); await new Promise((done) => setTimeout(done, 0)); };
const byId = (id: string) => document.getElementById(id)!;
const isShown = (id: string) => !byId(id).hidden;
const clickNamed = (name: string) => {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === name);
  expect(button, name).toBeTruthy();
  button!.click();
};

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { clearInterval(timer); document.body.innerHTML = ''; });

it('a new plugin asks for a server and offers the words', async () => {
  start(NOT_LINKED);
  await settle();
  expect(isShown('fb-connect')).toBe(true);
  expect(isShown('fb-linked')).toBe(false);
  expect(isShown('fb-key-none')).toBe(true);
  expect((byId('fb-run-all') as HTMLButtonElement).disabled).toBe(true);
  expect(byId('fb-state').textContent).toContain('Not connected');
});

it('connecting sends the server, and waits on the job while the person answers', async () => {
  let looks = 0;
  start(NOT_LINKED, {
    'link.connect': () => ({ jobId: 'j1' }),
    'jobs.get': () => (looks++ === 0 ? { state: 'running', message: 'Waiting for you to sign in in your browser' } : { state: 'done', result: { server: 'https://forms.example.test' } }),
  });
  await settle();
  (byId('fb-server') as HTMLInputElement).value = 'https://forms.example.test';
  byId('fb-connect').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  expect(calls.find((call) => call.name === 'link.connect')?.payload).toEqual({ server: 'https://forms.example.test' });
  await vi.waitFor(() => expect(byId('fb-said').textContent).toContain('Connected to https://forms.example.test'), { timeout: 3000 });
});

it('a computer waiting for approval is told where, with the fingerprint to compare', async () => {
  start({ ...NOT_LINKED, state: 'needs-approval', detail: 'Waiting for approval in FormLogic', linked: true, nodeStatus: 'pending', fingerprint: 'abcd 0123 abcd 0123 abcd 0123' });
  await settle();
  expect(isShown('fb-approve')).toBe(true);
  expect(byId('fb-approve').textContent).toContain('Data nodes');
  expect(byId('fb-fingerprint').textContent).toBe('abcd 0123 abcd 0123 abcd 0123');
  expect(byId('fb-linked-account').textContent).toBe('owner@example.test');
});

it('a link FormLogic ended says to connect again', async () => {
  start({ ...READY, state: 'needs-link', detail: 'FormLogic no longer accepts this link', approved: false });
  await settle();
  expect(isShown('fb-relink')).toBe(true);
  expect(isShown('fb-approve')).toBe(false);
});

it('a computer that cannot show windows says so', async () => {
  start({ ...NOT_LINKED, canAsk: false });
  await settle();
  expect(isShown('fb-no-windows')).toBe(true);
});

it('the twelve words leave the box as soon as they are used', async () => {
  start(NOT_LINKED, { 'key.recover': () => ({ jobId: 'j1' }), 'jobs.get': () => ({ state: 'done', result: { keyId: 'key-one' } }) });
  await settle();
  const typed = byId('fb-words') as HTMLTextAreaElement;
  typed.value = '  Abandon   ABOUT\n zoo ';
  byId('fb-recover-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  expect(typed.value).toBe('');
  await settle();
  expect(calls.find((call) => call.name === 'key.recover')?.payload).toEqual({ words: 'abandon about zoo' });
  await vi.waitFor(() => expect(byId('fb-said').textContent).toBe('Your key is ready.'));
});

it('names from FormLogic go on the page as text', async () => {
  const hostile = '<img src=x onerror="window.pwned=1">';
  start(READY, {
    'jobs.get': () => ({ state: 'done', result: { apps: [{ id: 'a1', name: hostile }], forms: [{ id: 'f1', title: hostile, inApp: false }, { id: 'f2', title: 'In an app', inApp: true }] } }),
    'backups.list': () => ({ backups: [{ id: 'x/app-a1/1', kind: 'app', sourceId: 'a1', name: hostile, createdAt: '2026-10-31T00:00:00Z', bytes: 2048, keyId: 'key-one', accountEmail: 'owner@example.test' }], total: 1, lastRun: { at: '2026-10-31T00:00:00Z', saved: 0, failed: [{ name: hostile, reason: 'no' }], stopped: null } }),
  });
  await vi.waitFor(() => expect(byId('fb-sources').children.length).toBe(2));
  await settle();
  expect(document.querySelector('img')).toBeNull();
  expect(byId('fb-backups').textContent).toContain(hostile);
  expect(byId('fb-last-run').textContent).toContain(hostile);
  expect(byId('fb-sources').textContent).not.toContain('In an app');
});

it('a backup can be restored, saved and deleted, each through its own window', async () => {
  const backup = { id: 'x/app-a1/1', kind: 'app', sourceId: 'a1', name: 'Bookings', createdAt: '2026-10-31T00:00:00Z', bytes: 2048, keyId: 'other-key' };
  start(READY, {
    'backups.list': () => ({ backups: [backup], total: 1, lastRun: null }),
    'backup.restore': () => ({ jobId: 'j1' }),
    'jobs.get': () => ({ state: 'failed', message: 'Nothing was changed.' }),
  });
  await vi.waitFor(() => expect(byId('fb-backups').textContent).toContain('Bookings'));
  expect(byId('fb-backups').textContent).toContain('sealed to other words');
  clickNamed('Restore…');
  await settle();
  expect(calls.find((call) => call.name === 'backup.restore')?.payload).toEqual({ id: backup.id });
  await vi.waitFor(() => expect(byId('fb-said').textContent).toBe('Nothing was changed.'));
  expect(byId('fb-said').className).not.toContain('is-bad');
});

it('more backups than one answer can hold come a page at a time', async () => {
  const backups = Array.from({ length: 700 }, (_, n) => ({ id: `x/app-a1/${n}`, kind: 'app', sourceId: 'a1', name: `Backup ${n}`, createdAt: '2026-10-31T00:00:00Z', bytes: 1, keyId: 'key-one', scheduled: true }));
  start(READY, {
    'backups.list': (payload) => {
      const offset = Number(payload.offset);
      const limit = Number(payload.limit);
      expect(limit).toBeLessThanOrEqual(500);
      return { backups: backups.slice(offset, offset + limit), total: backups.length, lastRun: null };
    },
  });
  await vi.waitFor(() => expect(byId('fb-backups').children.length).toBe(100));
  for (let shows = 200; shows <= 600; shows += 100) {
    byId('fb-backups-more').click();
    await vi.waitFor(() => expect(byId('fb-backups').children.length).toBe(shows));
  }
  expect(isShown('fb-backups-more')).toBe(true);
  byId('fb-backups-more').click();
  await vi.waitFor(() => expect(byId('fb-backups').children.length).toBe(700));
  expect(isShown('fb-backups-more')).toBe(false);
});

it('a backup nobody scheduled says it stays', async () => {
  start(READY, { 'backups.list': () => ({ backups: [{ id: 'x/app-a1/1', kind: 'app', sourceId: 'a1', name: 'Bookings', createdAt: '2026-10-31T00:00:00Z', bytes: 1, keyId: 'key-one', scheduled: false }], total: 1, lastRun: null }) });
  await vi.waitFor(() => expect(byId('fb-backups').textContent).toContain('kept until you delete it'));
});

it('a failed job says why', async () => {
  start(READY, { 'backup.run': () => ({ jobId: 'j1' }), 'jobs.get': () => ({ state: 'failed', message: 'A backup is already running.' }) });
  await settle();
  byId('fb-run-all').click();
  await vi.waitFor(() => expect(byId('fb-said').textContent).toBe('A backup is already running.'));
  expect(byId('fb-said').className).toContain('is-bad');
});

it('a plugin OAIY has not started says what to do', async () => {
  start(NOT_LINKED, { 'status.get': () => { throw new Error('The connector is not available: its plugin is Installed.'); } });
  await settle();
  expect(byId('fb-said').textContent).toContain('On the Plugins page, start it');
});

it('the schedule saves what the form says', async () => {
  start(READY, { 'settings.set': () => ({ jobId: 'j1' }), 'jobs.get': () => ({ state: 'done', result: {} }) });
  await settle();
  (byId('fb-enabled') as HTMLInputElement).checked = true;
  (byId('fb-every') as HTMLInputElement).value = '12';
  (byId('fb-keep') as HTMLInputElement).value = '3';
  byId('fb-schedule').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  expect(calls.find((call) => call.name === 'settings.set')?.payload).toEqual({ enabled: true, everyHours: 12, keep: 3 });
});

it('the page warns that uninstalling takes the backups with it', () => {
  expect(html).toContain('Uninstalling this plugin deletes them');
});
