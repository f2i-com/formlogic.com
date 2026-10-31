import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, test, type Page } from '@playwright/test';
import { sessionHeaders } from './session-request';

// The FormLogic Backups plugin against this server, end to end: the plugin's own program, a real
// browser for the sign-in and the owner's approval, and a real backup and restore.
//
// It needs a program built with `cargo build --features scripted-dialogs` in formlogic/oaiy-plugin,
// named by FORMLOGIC_BACKUPS_BIN, and a server with PRIVATE_FORMS and DATA_NODES on. CI has neither,
// so there it is skipped. Run it by hand before a release: docs/FORMLOGIC_BACKUPS.md says how.
const PROGRAM = process.env.FORMLOGIC_BACKUPS_BIN;
const RUN = Date.now().toString(36);
const VAULT_PASSPHRASE = 'plugin-e2e-vault-passphrase';

/** What the plugin's answers hold, between them. */
interface Reply {
  jobId: string;
  state: string;
  message: string;
  result: Reply;
  nodeStatus: string;
  fingerprint: string;
  keyId: string;
  endedAtServer: boolean;
  total: number;
  apps: { name: string }[];
  forms: { title: string }[];
  backups: { id: string; kind: string; sourceId: string; keyId: string }[];
}

/** The plugin's program, spoken to as OAIY speaks to it. */
class Plugin {
  private next = 1;
  private request = 1;
  private waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();

  private constructor(private child: ChildProcessWithoutNullStreams, readonly folder: string) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    });
  }

  static async start(): Promise<Plugin> {
    const folder = mkdtempSync(path.join(tmpdir(), 'fl-backups-e2e-'));
    const child = spawn(PROGRAM!, [], {
      env: { SystemRoot: process.env.SystemRoot ?? '', OAIY_PLUGIN_DATA_DIR: path.join(folder, 'data'), FORMLOGIC_BACKUPS_SCRIPTED: folder },
    });
    const plugin = new Plugin(child, folder);
    await plugin.rpc('plugin.init', { dataDir: path.join(folder, 'data') });
    return plugin;
  }

  private rpc(method: string, params: unknown) {
    const id = this.next++;
    return new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async command(command: string, payload: unknown = {}) {
    const { result } = await this.rpc('connector.request', { connectorId: 'formlogic-backups', command, payload, requestId: `e2e-${this.request++}` });
    const answer = result as { ok: boolean; data: Reply; error?: { message: string } };
    expect(answer.ok, answer.error?.message).toBe(true);
    return answer.data;
  }

  async job(command: string, payload: unknown = {}, timeout = 120_000): Promise<Reply> {
    const { jobId } = await this.command(command, payload);
    const until = Date.now() + timeout;
    for (;;) {
      const job = await this.command('jobs.get', { id: jobId });
      if (job.state !== 'running') return job;
      expect(Date.now()).toBeLessThan(until);
      await new Promise((done) => setTimeout(done, 200));
    }
  }

  async done(command: string, payload: unknown = {}, timeout?: number) {
    const job = await this.job(command, payload, timeout);
    expect(job.state, job.message).toBe('done');
    return job.result;
  }

  answer(...answers: string[]) {
    writeFileSync(path.join(this.folder, 'answers.txt'), answers.join('\n'));
  }

  asked() {
    return existsSync(path.join(this.folder, 'asked.txt')) ? readFileSync(path.join(this.folder, 'asked.txt'), 'utf8') : '';
  }

  opened() {
    return existsSync(path.join(this.folder, 'opened.txt')) ? readFileSync(path.join(this.folder, 'opened.txt'), 'utf8').trim() : '';
  }

  link() {
    return JSON.parse(readFileSync(path.join(this.folder, 'data', 'link.json'), 'utf8'));
  }

  stop() {
    this.child.stdin.end();
    this.child.kill();
    rmSync(this.folder, { recursive: true, force: true });
  }
}

function everyFile(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const file = path.join(folder, name);
    return statSync(file).isDirectory() ? everyFile(file) : [file];
  });
}

async function setUpVault(page: Page) {
  await page.goto('/settings#security');
  await page.getByRole('button', { name: 'Set up vault' }).click();
  await page.getByLabel('Vault passphrase').fill(VAULT_PASSPHRASE);
  await page.getByLabel('Confirm passphrase').fill(VAULT_PASSPHRASE);
  await page.getByRole('button', { name: 'Create vault' }).click();
  const kit = await page.locator('.select-all').innerText();
  await page.getByRole('button', { name: 'I saved it — continue' }).click();
  await page.getByRole('textbox', { name: 'Recovery kit' }).fill(kit);
  await page.getByRole('button', { name: /Confirm & create vault/ }).click();
  await expect(page.getByText('Unlocked', { exact: true })).toBeVisible({ timeout: 30_000 });
}

test('the plugin links, is approved, backs up, restores and lets go', async ({ page, context, baseURL }) => {
  test.skip(!PROGRAM, 'FORMLOGIC_BACKUPS_BIN names no program');
  test.setTimeout(300_000);

  const email = `plugin-${RUN}@e2e-apps.com`;
  const registered = await context.request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: 'plugin-e2e-password-1', name: 'Plugin' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const headers = { 'X-CSRF-Token': (await context.cookies()).find((cookie) => cookie.name === 'formlogic_csrf')!.value };
  const planted = `Sealed by the plugin ${RUN}`;
  const alone = await context.request.post('/api/forms', { headers, data: { title: planted, fields: [{ id: 'name', type: 'short_text', label: 'Name', required: false }] } });
  expect(alone.ok(), await alone.text()).toBe(true);
  const appName = `Bookings ${RUN}`;
  const app = await context.request.post('/api/apps', { headers, data: { name: appName } });
  expect(app.ok(), await app.text()).toBe(true);

  await setUpVault(page);

  const plugin = await Plugin.start();
  try {
    expect((await plugin.command('status.get')).state).toBe('needs-link');

    // The window names the server, and only then does a browser open.
    plugin.answer('yes');
    const { jobId } = await plugin.command('link.connect', { server: baseURL });
    await expect.poll(() => plugin.opened()).toContain('/oauth/authorize?');
    expect(plugin.asked()).toContain(baseURL!);

    // The consent page says what this is, and offers no app limit: the server would refuse one.
    await page.goto(plugin.opened());
    await expect(page.getByRole('heading', { name: 'Link FormLogic Backups' })).toBeVisible();
    await expect(page.getByText('Test Computer')).toBeVisible();
    await expect(page.getByLabel(/Limit access to one app/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Approve access' }).click();
    await expect(page.getByText('FormLogic Backups is connected.')).toBeVisible();

    await expect.poll(async () => (await plugin.command('jobs.get', { id: jobId })).state).toBe('done');
    expect(await plugin.command('link.get')).toMatchObject({ linked: true, server: baseURL, accountEmail: email });
    await expect.poll(async () => (await plugin.command('status.get')).nodeStatus).toBe('pending');
    const { fingerprint } = await plugin.command('status.get');

    // A key on its own reaches nothing yet.
    const { credential } = plugin.link();
    const bearer = { Authorization: `Bearer ${credential}` };
    expect((await context.request.get('/api/v1/data-node/backup-sources', { headers: bearer })).status()).toBe(403);
    expect((await context.request.get('/api/v1/flows', { headers: bearer })).status()).toBe(403);

    // The owner approves this computer, by the fingerprint the plugin shows.
    await page.goto('/settings#linked-desktops');
    const row = page.getByRole('listitem').filter({ hasText: 'FormLogic Backups on Test Computer' });
    await expect(row.getByText('Backups only')).toBeVisible();
    await expect(row.getByText(fingerprint)).toBeVisible();
    await row.getByRole('button', { name: 'Approve…' }).click();
    await page.getByLabel('Vault passphrase').fill(VAULT_PASSPHRASE);
    await page.getByRole('dialog').getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText(fingerprint).last()).toBeVisible();
    await page.getByRole('button', { name: 'Approve node' }).click();
    await expect(row.getByText('Approved')).toBeVisible();
    await expect.poll(async () => {
      await plugin.command('link.get');
      return (await plugin.command('status.get')).state;
    }, { timeout: 30_000 }).toBe('needs-words');

    // The words appear in the window and nowhere else.
    plugin.answer('yes');
    const { keyId } = await plugin.done('key.setup');
    const words = plugin.asked().split('\n').find((line) => line.startsWith('WORDS '))!.slice(6);
    expect(words.split(' ')).toHaveLength(12);
    expect((await plugin.command('status.get')).state).toBe('ready');

    const sources = await plugin.done('sources.list');
    expect(sources.apps.map((source) => source.name)).toContain(appName);
    expect(sources.forms.map((source) => source.title)).toContain(planted);

    const ran = await plugin.done('backup.run');
    expect(ran).toMatchObject({ saved: 2, failed: [], stopped: null });

    const { backups, total } = await plugin.command('backups.list');
    expect(total).toBe(2);
    expect(backups.every((backup) => backup.keyId === keyId)).toBe(true);
    const form = backups.find((backup) => backup.kind === 'form')!;
    const sealed = everyFile(path.join(plugin.folder, 'data', 'backups')).filter((file) => file.endsWith('.flbk'));
    expect(sealed).toHaveLength(2);
    for (const file of sealed) {
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 6).toString()).toBe('FLBK1\n');
      expect(bytes.includes(planted)).toBe(false);
    }

    // A backup started by a command is kept, however few the schedule keeps: a flow can start
    // as many as it likes, and they must not push out an older copy.
    plugin.answer('yes');
    await plugin.done('settings.set', { enabled: false, everyHours: 24, keep: 1 });
    expect(plugin.asked()).toContain('Keep 1 of each');
    await plugin.done('backup.run', { only: [{ kind: 'form', id: form.sourceId, name: planted }] });
    expect((await plugin.command('backups.list')).total).toBe(3);

    // A plain copy goes where the window says, and is a plain backup.
    const chosen = path.join(plugin.folder, 'chosen.zip');
    plugin.answer(`save ${chosen}`);
    await plugin.done('backup.save', { id: form.id });
    expect(readFileSync(chosen).subarray(0, 2).toString()).toBe('PK');

    // The sign-in alone can't ask for a backup sealed to a key of the thief's.
    const stolen = await context.request.post('/api/v1/data-node/source-backups', {
      headers: bearer,
      data: { kind: 'form', id: form.sourceId, recipientPk: Buffer.alloc(32, 7).toString('base64'), requestedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), recipientPkSignature: Buffer.alloc(64, 1).toString('base64') },
    });
    expect(stolen.status()).toBe(403);

    // Restoring says where everything is going, and adds a copy.
    plugin.answer('no');
    expect((await plugin.job('backup.restore', { id: form.id })).message).toBe('Nothing was changed.');
    expect(plugin.asked()).toContain(email);
    plugin.answer('yes');
    await plugin.done('backup.restore', { id: form.id });
    const after = await plugin.done('sources.list');
    expect(after.forms.filter((source) => source.title.includes(planted)).length).toBeGreaterThan(1);

    plugin.answer('yes');
    await plugin.done('backup.delete', { id: form.id });
    expect((await plugin.command('backups.list')).total).toBe(2);

    // Letting go ends the key at the server, and the owner can clear the record.
    plugin.answer('yes');
    expect((await plugin.done('link.forget')).endedAtServer).toBe(true);
    expect((await context.request.get('/api/v1/data-node/self', { headers: bearer })).status()).toBe(401);
    expect(existsSync(path.join(plugin.folder, 'data', 'link.json'))).toBe(false);
    await page.reload();
    await expect(row.getByText('Revoked')).toBeVisible();
    await row.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
    await expect(row).toHaveCount(0);
  } finally {
    plugin.stop();
  }
});
