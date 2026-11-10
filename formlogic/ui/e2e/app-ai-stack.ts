// What the App AI specs that use a stand-in OAIY computer share (app-ai-setup.spec.ts,
// app-ai-lane.spec.ts): the stack's administrator, the site set back to nothing, and the stand-in
// itself (backend/tests/Support/stub-oaiy-computer.php), started with a one-time code as OAIY is.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { sessionHeaders, E2E_FRONTEND_BASE_URL } from './session-request';

export const EMAIL = process.env.E2E_APP_AI_EMAIL;
export const PASSWORD = process.env.E2E_APP_AI_PASSWORD;
const STUB_OAIY = process.env.E2E_STUB_OAIY || path.resolve(process.cwd(), '../backend/tests/Support/stub-oaiy-computer.php');

export interface Admin { api: APIRequestContext; csrf: string; headers: Record<string, string> }

/** Sign the stack's administrator in, and confirm it is them (an administrator's changes need it). */
export async function signIn(context: BrowserContext): Promise<Admin> {
  const login = await context.request.post('/api/auth/login', { headers: sessionHeaders(), data: { email: EMAIL, password: PASSWORD } });
  expect(login.ok(), await login.text()).toBe(true);
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'formlogic_csrf')!.value;
  const confirmed = await context.request.post('/api/admin/confirm', { headers: { 'X-CSRF-Token': csrf }, data: { password: PASSWORD } });
  expect(confirmed.ok(), await confirmed.text()).toBe(true);
  return { api: context.request, csrf, headers: { 'X-CSRF-Token': csrf, 'X-Admin-Confirmation': (await confirmed.json()).confirmation } };
}

/** Nothing set up: no computer linked or chosen, Site AI off, apps not allowed, no model, the limits as they start. */
export async function nothingSetUp({ api, csrf, headers }: Admin): Promise<void> {
  expect((await api.delete('/api/admin/site-ai-desktop', { headers })).ok()).toBe(true);
  const connections = await (await api.get('/api/desktop-connections')).json();
  for (const connection of connections.connections ?? []) {
    expect((await api.delete(`/api/desktop-connections/${connection.id}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBe(true);
  }
  const plansAnswer = await (await api.get('/api/admin/plans', { headers })).json();
  const plans = plansAnswer.plans ?? plansAnswer.data ?? plansAnswer;
  expect((await api.put('/api/admin/plans', { headers, data: { ...plans, siteAiEnabled: false } })).ok()).toBe(true);
  expect((await api.put('/api/admin/app-ai', { headers, data: {} })).ok()).toBe(true);
}

/** A stand-in computer that is running: what it has said so far (a line a turn), and how to stop it. */
export interface StandInComputer { said: () => string; stop: () => void }

/**
 * Start the stand-in OAIY computer with a one-time code, as `oaiy-server link` would be. It links,
 * checks in, and answers what the site queues for it until stopped or $seconds have passed.
 */
export function startComputer(code: string, name: string, seconds = 220): StandInComputer {
  let output = '';
  let child: ChildProcess | null = spawn(process.env.PHP_BIN || 'php', ['-d', 'xdebug.mode=off', STUB_OAIY, E2E_FRONTEND_BASE_URL, code, name],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, STUB_OAIY_SECONDS: String(seconds) } });
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  return {
    said: () => output,
    stop: () => { if (child) { try { child.kill(); } catch { /* gone */ } child = null; } },
  };
}
