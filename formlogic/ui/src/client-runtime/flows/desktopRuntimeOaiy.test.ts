import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __resetOaiyDetectionForTests,
  __setOaiyBaseUrlForTests,
  probeOaiy,
  setOaiyToken,
} from '../oaiy/oaiyRuntime';
import { resolveDesktopLlmEndpoint } from './desktopLlm';
import { listAiSources, listDesktopServices, resolveDesktopServiceBase } from './desktopService';

// When OAIY Desktop is the paired runtime, the desktop-backed flow resolvers
// (local LLM endpoint, service base, service listing, AI sources) must resolve
// from OAIY's /api/services instead of FormLogic Desktop — so a flow's llm_chat /
// http_request / image_gen / desktop_services nodes run through OAIY.

const BASE = 'http://127.0.0.1:19995';
const healthy = { status: 'ok', product: 'oaiy-desktop', protocol: 'oaiy-bridge/1', version: '0.1.0' };

const OAIY_SERVICES = {
  services: [
    { id: 'llamacpp', name: 'llama.cpp', category: 'llm', status: 'running', port: 8080, defaultPort: 8080 },
    { id: 'krea2', name: 'Krea', category: 'image', status: 'stopped', port: 0, defaultPort: 7860 },
  ],
  dataDir: 'C:/data',
};

/** Route by path: /api/health → identity handshake, /api/services → the listing. */
function mockOaiy() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/health') ? healthy : url.includes('/api/services') ? OAIY_SERVICES : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
}

beforeEach(async () => {
  __setOaiyBaseUrlForTests(BASE);
  __resetOaiyDetectionForTests();
  setOaiyToken(null);
  mockOaiy();
  await probeOaiy(true); // detect OAIY
  setOaiyToken('tok'); // + hold a token → oaiyRouteAvailable() true
});
afterEach(() => {
  __resetOaiyBaseUrlForTests();
  __resetOaiyDetectionForTests();
  setOaiyToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('flow resolvers prefer OAIY when it is the paired runtime', () => {
  it('resolveDesktopLlmEndpoint picks OAIY\'s running llm service', async () => {
    const out = await resolveDesktopLlmEndpoint();
    expect(out).toEqual({ endpoint: 'http://127.0.0.1:8080/v1/chat/completions', service: 'llama.cpp' });
  });

  it('resolveDesktopServiceBase returns the loopback base of a running OAIY service', async () => {
    expect(await resolveDesktopServiceBase('llamacpp')).toBe('http://127.0.0.1:8080');
    // Present but stopped → null (the node surfaces "start it"), not a fallback.
    expect(await resolveDesktopServiceBase('krea2')).toBeNull();
  });

  it('listDesktopServices lists OAIY services with running-only URLs', async () => {
    const out = await listDesktopServices();
    expect(out).toEqual([
      { id: 'llamacpp', name: 'llama.cpp', category: 'llm', status: 'running', port: 8080, url: 'http://127.0.0.1:8080' },
      { id: 'krea2', name: 'Krea', category: 'image', status: 'stopped', port: 7860, url: '' },
    ]);
  });

  it('listAiSources degrades OAIY services to service-kind sources (chat for llm)', async () => {
    const out = await listAiSources();
    expect(out).toEqual([
      { id: 'service:llamacpp', kind: 'service', refId: 'llamacpp', name: 'llama.cpp', category: 'llm', status: 'running', capabilities: ['chat'], url: 'http://127.0.0.1:8080', model: '', enabled: true },
      { id: 'service:krea2', kind: 'service', refId: 'krea2', name: 'Krea', category: 'image', status: 'stopped', capabilities: [], url: '', model: '', enabled: true },
    ]);
  });
});
