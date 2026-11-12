import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __resetOaiyDetectionForTests,
  __setOaiyBaseUrlForTests,
  probeOaiy,
  setOaiyToken,
} from '../oaiy/oaiyRuntime';
import { resolveDesktopLlmEndpoint } from './desktopLlm';
import { generateDesktopImage, listAiSources, listDesktopServices, resolveDesktopServiceBase } from './desktopService';

// When OAIY Desktop is the paired runtime, the desktop-backed flow resolvers
// (local LLM endpoint, service base, service listing, AI sources) must resolve
// from OAIY's /api/services instead of FormLogic Desktop — so a flow's llm_chat /
// http_request / image_gen / desktop_services nodes run through OAIY.

const BASE = 'http://127.0.0.1:19995';
const healthy = { status: 'ok', product: 'oaiy-desktop', protocol: 'oaiy-bridge/1', version: '0.1.0' };

const OAIY_SERVICES = {
  services: [
    { id: 'llamacpp', name: 'llama.cpp', category: 'llm', status: 'running', port: 8080, defaultPort: 8080 },
    { id: 'my-pictures', name: 'My pictures', category: 'image', status: 'stopped', port: 0, defaultPort: 7860 },
  ],
  dataDir: 'C:/data',
};

// OAIY's /api/ai/sources union (services + credential-hidden providers).
const OAIY_AI_SOURCES = {
  sources: [
    {
      id: 'provider:openai',
      kind: 'provider',
      providerId: 'openai',
      name: 'OpenAI',
      category: null,
      status: 'provider',
      protocol: 'openai',
      capabilities: ['chat'],
      hasKey: true,
      enabled: true,
      model: 'gpt-4o-mini',
      useCases: ['flows'],
    },
    {
      id: 'service:llamacpp',
      kind: 'service',
      serviceId: 'llamacpp',
      name: 'llama.cpp',
      category: 'llm',
      status: 'running',
      port: 8080,
      capabilities: ['chat'],
      useCases: ['background', 'forms', 'flows', 'live-call'],
    },
  ],
};

/** Route by path: /api/health → identity, /api/ai/sources → the AI union,
 *  /api/services → the plain service listing. */
function mockOaiy() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/health')
        ? healthy
        : url.includes('/api/ai/sources')
          ? OAIY_AI_SOURCES
          : url.includes('/api/services')
            ? OAIY_SERVICES
            : {};
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
    expect(await resolveDesktopServiceBase('my-pictures')).toBeNull();
  });

  it('listDesktopServices lists OAIY services with running-only URLs', async () => {
    const out = await listDesktopServices();
    expect(out).toEqual([
      { id: 'llamacpp', name: 'llama.cpp', category: 'llm', status: 'running', port: 8080, url: 'http://127.0.0.1:8080' },
      { id: 'my-pictures', name: 'My pictures', category: 'image', status: 'stopped', port: 7860, url: '' },
    ]);
  });

  it('listAiSources returns OAIY\'s gateway union (providers + services) mapped for the picker', async () => {
    const out = await listAiSources();
    expect(out).toEqual([
      // A credential-hidden provider — must carry chat + the flows use-case so
      // isDesktopFlowChatProvider accepts it for flow routing.
      { id: 'provider:openai', kind: 'provider', refId: 'openai', name: 'OpenAI', category: '', status: 'provider', capabilities: ['chat'], useCases: ['flows'], url: '', model: 'gpt-4o-mini', enabled: true },
      { id: 'service:llamacpp', kind: 'service', refId: 'llamacpp', name: 'llama.cpp', category: 'llm', status: 'running', capabilities: ['chat'], useCases: ['background', 'forms', 'flows', 'live-call'], url: 'http://127.0.0.1:8080', model: '', enabled: true },
    ]);
  });
});

// The image step's default source: OAIY's own engine, through the route OAIY forwards for a
// paired app (scope ai.use). The page names no model: OAIY answers with the one chosen there.
describe('a picture from the paired OAIY', () => {
  function answerImages(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      })
    );
    return calls;
  }

  it('asks the engine gateway with the pairing token and returns its answer', async () => {
    const calls = answerImages(200, { data: [{ b64_json: 'QUJD' }] });
    const out = await generateDesktopImage({ prompt: 'a fox', n: 1, response_format: 'b64_json' });
    expect(out).toEqual({ ok: true, data: { data: [{ b64_json: 'QUJD' }] } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/ai/engine/gateway/v1/images/generations`);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0].init?.credentials).toBe('omit');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ prompt: 'a fox', n: 1, response_format: 'b64_json' });
  });

  it('passes on what OAIY said when it refuses, in either error shape', async () => {
    answerImages(503, { error: { code: 'engine_unavailable', message: 'The engines are not running.' } });
    expect(await generateDesktopImage({ prompt: 'a fox' })).toEqual({ ok: false, message: 'The engines are not running.' });
    answerImages(400, { error: 'no picture model is switched on' });
    expect(await generateDesktopImage({ prompt: 'a fox' })).toEqual({ ok: false, message: 'no picture model is switched on' });
    answerImages(502, 'not json');
    expect(await generateDesktopImage({ prompt: 'a fox' })).toEqual({ ok: false, message: 'OAIY answered HTTP 502' });
  });

  it('is null, and asks nothing, when no OAIY is paired with this browser', async () => {
    const calls = answerImages(200, { data: [] });
    setOaiyToken(null);
    expect(await generateDesktopImage({ prompt: 'a fox' })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
