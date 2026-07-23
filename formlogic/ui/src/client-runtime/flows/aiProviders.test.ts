import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDER_PRESETS,
  clearProviderKey,
  deleteProvider,
  exportProviderJson,
  extractByPath,
  getProvider,
  getProviderKey,
  listProviders,
  parseProviderImport,
  renderRequestTemplate,
  resolveProviderRequest,
  saveProvider,
  setProviderKey,
  vaultMode,
  type AiProviderConfig,
} from './aiProviders';

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.has(key) ? this.items.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function provider(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: 'p1',
    name: 'Provider One',
    kind: 'custom',
    baseUrl: 'https://api.example.test/v1',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('indexedDB', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI provider registry', () => {
  it('stores providers per user and normalizes base URLs', () => {
    saveProvider('u1', provider({ baseUrl: 'https://api.example.test/v1///' }));
    saveProvider('u2', provider({ id: 'p2', name: 'Other' }));

    expect(listProviders('u1')).toHaveLength(1);
    expect(listProviders('u1')[0].baseUrl).toBe('https://api.example.test/v1');
    expect(getProvider('u1', 'p1')?.name).toBe('Provider One');
    expect(getProvider('u2', 'p1')).toBeNull();

    deleteProvider('u1', 'p1');
    expect(listProviders('u1')).toEqual([]);
    expect(listProviders('u2')).toHaveLength(1);
  });

  it('exposes preset defaults and CORS hints', () => {
    expect(AI_PROVIDER_PRESETS.openai.defaults.baseUrl).toBe('https://api.openai.com/v1');
    // Deliberately NO default model: model names churn too fast to hardcode —
    // the user types one or picks from the editor's "Fetch models" helper.
    expect(AI_PROVIDER_PRESETS.openai.defaults.model).toBeUndefined();
    expect(AI_PROVIDER_PRESETS.openai.keyRequired).toBe(true);
    expect(AI_PROVIDER_PRESETS.ollama.defaults.baseUrl).toBe('http://localhost:11434/v1');
    expect(AI_PROVIDER_PRESETS.ollama.corsHint).toMatch(/OLLAMA_ORIGINS/);
    expect(AI_PROVIDER_PRESETS.lmstudio.corsHint).toMatch(/CORS/);
    expect(AI_PROVIDER_PRESETS.custom.defaults.baseUrl).toBe('');
  });

  it('round-trips API keys in plain mode when encrypted browser vault APIs are unavailable', async () => {
    saveProvider('u1', provider());
    expect(vaultMode()).toBe('plain');

    await setProviderKey('u1', 'p1', 'sk-test');
    const saved = getProvider('u1', 'p1');
    expect(saved?.encryptedKey?.mode).toBe('plain');
    expect(saved?.encryptedKey?.ct).not.toBe('sk-test');
    expect(await getProviderKey('u1', 'p1')).toBe('sk-test');

    clearProviderKey('u1', 'p1');
    expect(await getProviderKey('u1', 'p1')).toBeNull();
  });

  it('round-trips API keys in GCM mode when WebCrypto and IndexedDB are available', async () => {
    if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') return;

    vi.stubGlobal('indexedDB', createMemoryIndexedDB());
    saveProvider('u1', provider());
    expect(vaultMode()).toBe('encrypted');

    await setProviderKey('u1', 'p1', 'sk-gcm');
    const saved = getProvider('u1', 'p1');
    expect(saved?.encryptedKey?.mode).toBe('gcm');
    expect(saved?.encryptedKey?.iv).toEqual(expect.any(String));
    expect(saved?.encryptedKey?.ct).not.toBe('sk-gcm');
    expect(await getProviderKey('u1', 'p1')).toBe('sk-gcm');
  });

  it('blocks attaching keys over non-loopback HTTP', async () => {
    saveProvider('u1', provider({
      baseUrl: 'http://provider.example.test/v1',
      headers: [
        { name: 'X-Api-Key', value: '{{apiKey}}' },
        { name: 'X-Static', value: '1' },
      ],
    }));
    await setProviderKey('u1', 'p1', 'sk-test');

    const resolved = await resolveProviderRequest('u1', 'chat', 'p1');

    expect(resolved?.url).toBe('http://provider.example.test/v1/chat/completions');
    expect(resolved?.keyBlocked).toBe(true);
    expect(resolved?.apiKey).toBeUndefined();
    expect(resolved?.headers.Authorization).toBeUndefined();
    expect(resolved?.headers['X-Api-Key']).toBeUndefined();
    expect(resolved?.headers['X-Static']).toBe('1');
  });

  it('exports and imports provider JSON without saved keys', async () => {
    saveProvider('u1', provider({
      headers: [{ name: 'X-Api-Key', value: '{{apiKey}}' }],
      chatPath: 'chat/completions',
      requestTemplate: '{"model": {{model}}}',
    }));
    await setProviderKey('u1', 'p1', 'sk-export');

    const exported = exportProviderJson(getProvider('u1', 'p1')!);
    expect(exported).toContain('"formlogicAiService": 1');
    expect(exported).not.toContain('encryptedKey');
    expect(exported).not.toContain('sk-export');

    const [parsed] = parseProviderImport(exported);
    expect(parsed).toMatchObject({
      id: 'p1',
      name: 'Provider One',
      kind: 'custom',
      baseUrl: 'https://api.example.test/v1',
      enabled: true,
      headers: [{ name: 'X-Api-Key', value: '{{apiKey}}' }],
      chatPath: '/chat/completions',
      requestTemplate: '{"model": {{model}}}',
    });
    expect(parsed.encryptedKey).toBeUndefined();
  });

  it('imports arrays of provider JSON', () => {
    const text = JSON.stringify([
      JSON.parse(exportProviderJson(provider())),
      JSON.parse(exportProviderJson(provider({ id: 'p2', name: 'Provider Two', kind: 'ollama' }))),
    ]);

    expect(parseProviderImport(text).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('rejects bad provider imports with helpful errors', () => {
    expect(() => parseProviderImport('{nope')).toThrow(/valid JSON/);
    expect(() => parseProviderImport(JSON.stringify({ id: 'p1' }))).toThrow(/marker/);
    expect(() => parseProviderImport(JSON.stringify({ formlogicAiService: 1, id: 'p1', name: 'Bad', kind: 'bogus', baseUrl: '' }))).toThrow(/kind/);
  });

  it('scopes providers to their declared capabilities (absent list = all three)', async () => {
    saveProvider('u1', provider({ capabilities: ['speech'] }));
    expect(await resolveProviderRequest('u1', 'speech', 'p1')).not.toBeNull();
    expect(await resolveProviderRequest('u1', 'chat', 'p1')).toBeNull();
    expect(await resolveProviderRequest('u1', 'transcription', 'p1')).toBeNull();

    // Legacy records (no capabilities field) keep resolving everything.
    saveProvider('u1', provider({ id: 'p2', name: 'Legacy' }));
    expect(await resolveProviderRequest('u1', 'chat', 'p2')).not.toBeNull();
    expect(await resolveProviderRequest('u1', 'speech', 'p2')).not.toBeNull();
  });

  it('presets declare honest capability defaults and export/import round-trips them', () => {
    expect(AI_PROVIDER_PRESETS.openai.defaults.capabilities).toEqual(['chat', 'transcription', 'speech']);
    expect(AI_PROVIDER_PRESETS.ollama.defaults.capabilities).toEqual(['chat']);
    expect(AI_PROVIDER_PRESETS.lmstudio.defaults.capabilities).toEqual(['chat']);
    expect(AI_PROVIDER_PRESETS.custom.defaults.capabilities).toEqual(['chat']);

    const [parsed] = parseProviderImport(exportProviderJson(provider({ capabilities: ['transcription', 'speech'] })));
    expect(parsed.capabilities).toEqual(['transcription', 'speech']);
    expect(() => parseProviderImport(JSON.stringify({
      formlogicAiService: 1, id: 'p9', name: 'Bad caps', kind: 'custom', baseUrl: 'https://x.test', capabilities: ['flying'],
    }))).toThrow(/capabilities/);
  });
});

describe('AI provider helpers', () => {
  it('extracts values by dotted paths through arrays and objects', () => {
    const payload = { choices: [{ message: { content: 'hello' } }] };
    expect(extractByPath(payload, 'choices.0.message.content')).toBe('hello');
    expect(extractByPath(payload, 'choices.1.message.content')).toBeUndefined();
    expect(extractByPath(payload, 'choices.nope.message.content')).toBeUndefined();
  });

  it('renders request templates with JSON escaping and bare JSON placeholders', () => {
    const body = renderRequestTemplate(
      '{"model": {{model}}, "messages": {{messages}}, "text": "Say {{prompt}}", "limit": {{maxTokens}}}',
      {
        model: 'm1',
        messages: [{ role: 'user', content: 'Hi' }],
        prompt: 'A "quoted"\nline',
        maxTokens: 12,
      }
    );

    expect(body).toEqual({
      model: 'm1',
      messages: [{ role: 'user', content: 'Hi' }],
      text: 'Say A "quoted"\nline',
      limit: 12,
    });
  });

  it('throws a descriptive error when a rendered template is not valid JSON', () => {
    expect(() => renderRequestTemplate('{"model": {{model}', { model: 'm1' })).toThrow(/valid JSON/);
  });
});

function createMemoryIndexedDB(): IDBFactory {
  let created = false;
  const records = new Map<string, unknown>();
  const db = {
    objectStoreNames: {
      contains: (name: string) => created && name === 'keys',
    },
    createObjectStore: () => {
      created = true;
    },
    transaction: () => ({
      objectStore: () => ({
        get: (id: string) => requestWith(records.get(id)),
        put: (value: { id: string }) => {
          records.set(value.id, value);
          return requestWith(undefined);
        },
      }),
    }),
    close: vi.fn(),
  };

  return {
    open: () => {
      const req = requestShell(db);
      queueMicrotask(() => {
        req.onupgradeneeded?.({ target: req } as unknown as IDBVersionChangeEvent);
        queueMicrotask(() => req.onsuccess?.({ target: req } as unknown as Event));
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function requestShell(result: unknown): IDBOpenDBRequest {
  return {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  } as unknown as IDBOpenDBRequest;
}

function requestWith(result: unknown): IDBOpenDBRequest {
  const req = requestShell(undefined);
  queueMicrotask(() => {
    (req as { result: unknown }).result = result;
    req.onsuccess?.({ target: req } as unknown as Event);
  });
  return req;
}
