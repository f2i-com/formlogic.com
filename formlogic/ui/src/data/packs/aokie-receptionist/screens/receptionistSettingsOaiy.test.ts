// The Receptionist Settings screen on the OAIY route, run as the COMPILED
// sandbox artifact against a mocked window.FormLogic: OAIY is the default for
// a new record, an existing record's route is never moved without the
// operator's "Use OAIY", the lanes / voice / audio cards give way to "Set in
// OAIY", and a push that does not land (OAIY away, consent, restart) says so.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AOKIE_RECEPTIONIST_SETTINGS_SCREEN } from './receptionistSettingsScreen';
import { DEFAULT_PERSONA } from '../persona';
import {
  flushScreen as flush,
  runScreen,
  setupScreenTestEsbuild,
  teardownScreenTestEsbuild,
} from '../../aokieScreenTestHarness';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

const OAIY_ENDPOINT = 'ws://127.0.0.1:17872/api/ai/providers/oaiy/v1/realtime/stream';
const OAIY_LIVE = {
  aiReceptionist: true,
  realtimeVoiceMode: 'desktop_realtime',
  realtimeVoiceEndpoint: OAIY_ENDPOINT,
  realtimeVoiceDestination: 'https://oaiy.localhost',
  greeting: 'Thanks for calling!',
  persona: 'You are the phone receptionist for Pirate Cuts.',
};
const LANES_LIVE = { aiReceptionist: true, greeting: 'Hi', persona: 'P', ttsVoice: 'amy' };

interface Calls {
  set: Array<Record<string, unknown>>;
  submit: Array<Record<string, unknown>>;
  update: Array<{ id: unknown; answers: Record<string, unknown> }>;
  service: string[];
}

function mockFl(opts: {
  records?: Array<{ id: string; answers: Record<string, unknown> }>;
  live?: Record<string, unknown>;
  presence?: Record<string, unknown>;
  setOutcome?: (payload: Record<string, unknown>) => Record<string, unknown>;
  connections?: Array<Record<string, unknown>>;
  aiSources?: Array<Record<string, unknown>> | null;
  getFails?: boolean;
}) {
  const calls: Calls = { set: [], submit: [], update: [], service: [] };
  let live = { ...(opts.live ?? {}) };
  const fl: Record<string, unknown> = {
    presence: () => Promise.resolve(opts.presence ?? { kind: 'local' }),
    can: () => Promise.resolve(true),
    currentUser: () => Promise.resolve(null),
    aiSources: () => Promise.resolve(opts.aiSources ?? null),
    records: () => Promise.resolve(opts.records ?? []),
    service: (op: string) => {
      calls.service.push(op);
      if (op === 'desktop.connections.list' && opts.connections) {
        return Promise.resolve({ status: 'done', result: { connections: opts.connections } });
      }
      return Promise.resolve({ status: 'failed', error: { message: 'forbidden' } });
    },
    connector: (_id: string, cmd: string, payload: Record<string, unknown>) => {
      if (cmd === 'settings.get') {
        if (opts.getFails) {
          return Promise.resolve({ status: 'failed', error: { code: 'connector_unavailable', message: 'no desktop' } });
        }
        return Promise.resolve({ status: 'done', result: { settings: live, configVersion: 3 } });
      }
      calls.set.push(payload);
      const out = opts.setOutcome ? opts.setOutcome(payload) : { status: 'done', result: {} };
      if (out.status === 'done') live = { ...live, ...payload };
      return Promise.resolve(out);
    },
    submit: (answers: Record<string, unknown>) => {
      calls.submit.push(answers);
      return Promise.resolve({ id: 'rec-new-1' });
    },
    updateRecord: (id: unknown, answers: Record<string, unknown>) => {
      calls.update.push({ id, answers });
      return Promise.resolve({});
    },
    toast: { success: () => Promise.resolve(true), error: () => Promise.resolve(true), info: () => Promise.resolve(true) },
  };
  return { fl, calls };
}

const click = (root: HTMLElement, sel: string) => (root.querySelector(sel) as HTMLButtonElement).click();

describe('Receptionist Settings on the OAIY route', () => {
  it('a new record starts on OAIY: the route is chosen, OAIY owns the voice cards, and apply sends only the route', async () => {
    const { fl, calls } = mockFl({
      live: LANES_LIVE,
      setOutcome: (payload) => ({ status: 'done', result: { appliesAtReconnect: Object.keys(payload) } }),
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);

    expect((root.querySelector('input[data-route="oaiy"]') as HTMLInputElement).checked).toBe(true);
    expect(root.querySelector('[data-set-in-oaiy]')).not.toBeNull();
    expect(root.querySelector('[data-set-in-oaiy-row="callbacks"]')?.textContent).toContain('OAIY > Agent > Phone');
    for (const gone of ['[data-lane="llm"]', '[data-audio="mode"]', 'select[data-eng="engine"]', '[data-act="toggle-adv"]']) {
      expect(root.querySelector(gone), gone).toBeNull();
    }
    // What OAIY still uses stays: greeting, the brief, Background AI, screening, call waiting.
    for (const kept of ['[data-d="greeting"]', '[data-d="instructions"]', '[data-background-ai]', '[data-sc="blockedNumbers"]', '[data-act="save-waiting"]']) {
      expect(root.querySelector(kept), kept).not.toBeNull();
    }
    expect(root.querySelector('[data-brief-hint]')?.textContent).toContain('take precedence');
    expect(root.querySelector('[data-oaiy-route]')?.textContent).toContain("Aokie's own speech");
    expect(root.querySelector('[data-use-oaiy-offer]')).not.toBeNull();

    click(root, '[data-act="save-apply"]');
    await flush(80);
    expect(calls.submit).toHaveLength(1);
    expect(calls.submit[0].call_route).toBe('oaiy');
    expect(calls.set).toHaveLength(1);
    expect(calls.set[0]).toEqual({
      persona: DEFAULT_PERSONA,
      greeting: 'Thanks for calling! How can I help you today?',
      aiReceptionist: true,
      realtimeVoiceMode: 'desktop_realtime',
      realtimeVoiceEndpoint: OAIY_ENDPOINT,
      realtimeVoiceDestination: 'https://oaiy.localhost',
    });
    // The route moves when Aokie restarts: said plainly, with where to do it.
    expect(root.querySelector('[data-apply-note="warn"]')?.textContent).toContain('restart it in OAIY > Plugins > Aokie');
    expect(root.querySelector('[data-oaiy-route]')?.textContent).toContain('OAIY');
  });

  it('an existing record with no route whose Aokie already sends calls to OAIY shows as OAIY, pending a save', async () => {
    const { fl, calls } = mockFl({
      records: [{ id: 'r1', answers: { business_name: 'Pirate Cuts', active: 'yes' } }],
      live: OAIY_LIVE,
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);

    expect((root.querySelector('input[data-route="oaiy"]') as HTMLInputElement).checked).toBe(true);
    expect(root.querySelector('[data-route-adopted]')).not.toBeNull();
    expect(root.querySelector('.savebar .dirty')?.textContent).toBe('Unsaved changes');
    expect(root.querySelector('[data-running-mode]')?.textContent).toContain('OAIY (this computer)');
    expect(root.querySelector('[data-running-provider]')?.textContent).toContain('OAIY Front desk agent');
    // The model and voice are OAIY's: the OAIY card shows them, not the running card.
    expect(root.querySelector('[data-running-model]')).toBeNull();
    expect(root.querySelector('[data-oaiy-model]')?.textContent).toContain('Chosen in OAIY > Engines');
    expect(root.querySelector('[data-use-oaiy-offer]')).toBeNull();
    expect(calls.set).toHaveLength(0);

    click(root, '[data-act="record-oaiy"]');
    await flush(60);
    expect(calls.set).toHaveLength(0);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].answers.call_route).toBe('oaiy');
    expect(root.querySelector('.savebar .clean')?.textContent).toBe('Saved');
  });

  it("never moves a saved non-OAIY route by itself; Use OAIY is the one explicit move", async () => {
    const { fl, calls } = mockFl({
      records: [{ id: 'r1', answers: { business_name: 'Pirate Cuts', active: 'yes', llm_source: 'provider:acme' } }],
      live: { ...LANES_LIVE, realtimeVoiceMode: 'desktop_realtime', realtimeVoiceEndpoint: 'ws://127.0.0.1:17872/api/ai/providers/openai-gpt-realtime-2-1-mini/v1/realtime/stream' },
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);

    expect((root.querySelector('input[data-route="aokie-settings"]') as HTMLInputElement).checked).toBe(true);
    expect(root.querySelector('.savebar .clean')?.textContent).toBe('Saved');
    expect(root.querySelector('[data-oaiy-route]')?.textContent).toContain('Another realtime provider');
    expect(root.querySelector('[data-use-oaiy-offer]')?.textContent).toContain('Nothing moves until you choose');
    expect(root.querySelector('[data-lane="llm"]')).not.toBeNull();
    expect(calls.set).toHaveLength(0);

    click(root, '[data-act="use-oaiy"]');
    await flush(80);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].answers.call_route).toBe('oaiy');
    expect(calls.set).toHaveLength(1);
    expect(calls.set[0].realtimeVoiceEndpoint).toBe(OAIY_ENDPOINT);
    expect('aiEndpoint' in calls.set[0]).toBe(false);
    expect(root.querySelector('[data-lane="llm"]')).toBeNull();
  });

  it('a consent block is shown as the one thing to do', async () => {
    const { fl } = mockFl({
      records: [{ id: 'r1', answers: { call_route: 'oaiy', active: 'yes' } }],
      live: LANES_LIVE,
      setOutcome: () => ({ status: 'done', result: { blocked: 'realtimeVoiceDestination not consented', appliesAtReconnect: ['realtimeVoiceMode'] } }),
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    click(root, '[data-act="save-apply"]');
    await flush(80);
    const note = root.querySelector('[data-apply-note="bad"]')?.textContent ?? '';
    expect(note).toContain('Aokie paused the receptionist');
    expect(note).toContain('Plugins > Aokie > Consent');
  });

  it('OAIY away: the card says when it was last seen, and an apply says it was saved but not applied', async () => {
    const lastSeen = new Date(Date.now() - 12 * 60000).toISOString();
    const { fl, calls } = mockFl({
      records: [{ id: 'r1', answers: { call_route: 'oaiy', active: 'yes', greeting: 'Ahoy' } }],
      presence: { kind: 'none' },
      getFails: true,
      connections: [{ deviceName: 'FRONT-DESK', lastSeenAt: lastSeen }],
      setOutcome: () => ({ status: 'failed', error: { code: 'connector_unavailable', message: 'no desktop' } }),
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    expect(calls.service).toContain('desktop.connections.list');
    const offline = root.querySelector('[data-oaiy-offline]')?.textContent ?? '';
    expect(offline).toContain('FRONT-DESK was last seen 12 min ago');
    expect(offline).toContain('keeps answering calls, lookups and appointment requests');
    expect(root.querySelector('.running [data-running-empty]')?.textContent).toContain('OAIY is offline');

    click(root, '[data-act="save-apply"]');
    await flush(80);
    expect(calls.update).toHaveLength(1);
    const note = root.querySelector('[data-apply-note="warn"]')?.textContent ?? '';
    expect(note).toContain('Saved in FormLogic, not applied yet');
    expect(note).toContain('FRONT-DESK was last seen');
    expect(note).toContain('next incoming call once OAIY is back');
    expect(root.querySelector('#err')).toBeNull();
  });

  it('a card push while OAIY is away says it was not applied, never a raw transport error', async () => {
    const { fl } = mockFl({
      records: [{ id: 'r1', answers: { call_route: 'oaiy', active: 'yes' } }],
      live: OAIY_LIVE,
      setOutcome: () => ({ status: 'expired' }),
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    click(root, '[data-act="save-waiting"]');
    await flush(60);
    const err = root.querySelector('#err')?.textContent ?? '';
    expect(err).toContain('Call waiting not applied');
    expect(err).toContain('within a minute');
    expect(err).toContain('Nothing changed on the phone');
  });

  it('shows the model and voice OAIY reports through its source list', async () => {
    const { fl } = mockFl({
      records: [{ id: 'r1', answers: { call_route: 'oaiy', active: 'yes' } }],
      live: OAIY_LIVE,
      aiSources: [
        { kind: 'service', id: 'service:oaiy-voice', refId: 'oaiy-voice', name: 'OAIY Voice', category: 'Speech', status: 'running', url: 'http://127.0.0.1:17872', capabilities: ['speech'] },
        { kind: 'provider', id: 'provider:oaiy', refId: 'oaiy', name: 'OAIY', category: 'AI', status: 'provider', url: '', capabilities: ['chat'], enabled: true, model: 'Qwen3.8-Flash-Next' },
      ],
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    expect(root.querySelector('[data-oaiy-model]')?.textContent).toContain('Qwen3.8-Flash-Next');
    expect(root.querySelector('[data-oaiy-voice]')?.textContent).toContain('OAIY Voice running');
    expect(root.querySelector('[data-oaiy-callbacks]')?.textContent).toContain('OAIY rings them back');
    expect(root.querySelector('[data-screening-shared]')?.textContent).toContain('Who is answered');
  });
});
