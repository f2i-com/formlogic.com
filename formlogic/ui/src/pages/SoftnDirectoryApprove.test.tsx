// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoftnDraft } from '../types/app';

const getDraft = vi.fn();
const approve = vi.fn();
vi.mock('../lib/api', () => ({ api: { getSoftnDraft: (id: string) => getDraft(id), approveSoftnDraft: (id: string, anyway?: boolean) => approve(id, anyway) } }));

import { SoftnDirectoryApprove } from './SoftnDirectoryApprove';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const waiting: SoftnDraft = {
  draftId: 'a'.repeat(32), appId: 'app-1', status: 'awaiting_approval', destination: 'https://softn.com', target: null,
  sha256: 'b'.repeat(64), bytes: 2048, listing: { name: 'Tide Times', description: 'High and low water.', category: 'tools' },
  permissions: { net: { enabled: true, allowed_hosts: ['api.tides.example'] } },
  warnings: ['The app’s backend (1 file in server/) is left out.'], previewUrl: '/apps/app-1/softn', approvalUrl: '/softn-directory/approve/' + 'a'.repeat(32),
  expiresAt: '2026-11-04 00:00:00', error: null, publication: null,
};
let root: Root | null = null;
let container: HTMLDivElement;

async function open() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/softn-directory/approve/${'a'.repeat(32)}`]}>
        <Routes><Route path="/softn-directory/approve/:draftId" element={<SoftnDirectoryApprove />} /></Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });
}

const button = (name: RegExp) => Array.from(container.querySelectorAll('button')).find((b) => name.test(b.textContent ?? ''));

beforeEach(() => {
  getDraft.mockReset().mockResolvedValue({ data: waiting });
  approve.mockReset().mockResolvedValue({ data: { ...waiting, status: 'published', publication: { slug: 'tide-times', name: 'Tide Times', directory: 'https://softn.com', page: 'https://softn.com/app/tide-times', play: 'https://softn.com/play/tide-times', version: 1, appId: 'app-1', updatedAt: '' } } });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

describe('approving a draft for the SoftN directory', () => {
  it('says where it goes, who sees it, what it may use and what it is, before anything is public', async () => {
    await open();
    const text = container.textContent ?? '';
    expect(text).toContain('Tide Times');
    expect(text).toContain('Nothing is public until you approve');
    expect(text).toContain('https://softn.com');
    expect(text).toContain('Anyone. It is listed in the directory');
    expect(text).toContain('the network (api.tides.example)');
    expect(text).toContain('sha256 ' + 'b'.repeat(64));
    expect(text).toContain('server/');
    expect(approve).not.toHaveBeenCalled();
  });

  it('shows everything that goes public: the words an agent chose and the files', async () => {
    getDraft.mockResolvedValue({ data: { ...waiting, listing: { ...waiting.listing, author: 'A. N. Agent', tags: ['tides', 'sea'], notes: 'First cut.' }, files: ['index.html', 'manifest.json'] } });
    await open();
    const text = container.textContent ?? '';
    expect(text).toContain('A. N. Agent');
    expect(text).toContain('tides, sea');
    expect(text).toContain('First cut.');
    expect(text).toContain('2 files, readable by anyone');
    expect(text).toContain('manifest.json');
  });

  it('says so when an app may reach any site, in words and not capability names', async () => {
    getDraft.mockResolvedValue({ data: { ...waiting, permissions: { net: { enabled: true }, camera: { enabled: true }, mic: { enabled: false } } } });
    await open();
    const text = container.textContent ?? '';
    expect(text).toContain('the network (any site), the camera');
    expect(text).not.toContain('microphone');
  });

  it('offers no way to publish a draft the app has moved on from', async () => {
    getDraft.mockResolvedValue({ data: { ...waiting, appChanged: true } });
    await open();
    expect(container.textContent).toContain('The app has changed since this draft was made');
    expect(button(/Publish/)).toBeUndefined();
    getDraft.mockResolvedValue({ data: { ...waiting, status: 'uncertain', appChanged: true } });
    await act(async () => root?.unmount());
    container.remove();
    await open();
    expect(button(/try again/)).toBeUndefined();
  });

  it('when refused, reads the draft again so the buttons say what is left', async () => {
    await open();
    approve.mockResolvedValue({ error: 'The last attempt may have reached the directory.' });
    getDraft.mockResolvedValue({ data: { ...waiting, status: 'uncertain', error: 'No clear answer from the directory.' } });
    await act(async () => { button(/Publish to the SoftN directory/)!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('The last attempt may have reached the directory.');
    expect(button(/Publish to the SoftN directory/)).toBeUndefined();
    expect(button(/I checked: try again/)).toBeDefined();
  });

  it('sends someone signed out (or in the demo) through sign-in, not to a 404', () => {
    const routes = readFileSync(join(__dirname, '../App.tsx'), 'utf8');
    expect(routes.match(/path="\/softn-directory\/approve\/:draftId" element=\{<SignInFirst \/>\}/g)).toHaveLength(2);
    expect(routes).toContain('path="/softn-directory/approve/:draftId" element={<SoftnDirectoryApprove />}');
  });

  it('is not a second main landmark inside the app shell', async () => {
    await open();
    expect(container.querySelector('main')).toBeNull();
  });

  it('publishes on the person’s click, then shows the app’s links and no button', async () => {
    await open();
    await act(async () => { button(/Publish to the SoftN directory/)!.click(); });
    expect(approve).toHaveBeenCalledWith('a'.repeat(32), false);
    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining(['https://softn.com/app/tide-times', 'https://softn.com/play/tide-times']));
    expect(button(/Publish/)).toBeUndefined();
  });

  it('after an unclear try, asks the person to check before trying again', async () => {
    getDraft.mockResolvedValue({ data: { ...waiting, status: 'uncertain', error: 'No clear answer from the directory.' } });
    await open();
    expect(button(/Publish to the SoftN directory/)).toBeUndefined();
    await act(async () => { button(/I checked: try again/)!.click(); });
    expect(approve).toHaveBeenCalledWith('a'.repeat(32), true);
  });
});
