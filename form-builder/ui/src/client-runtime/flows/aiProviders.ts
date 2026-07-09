export type AiCapability = 'chat' | 'transcription' | 'speech';
export type AiProviderKind = 'openai' | 'ollama' | 'lmstudio' | 'custom';

export interface AiProviderHeader {
  name: string;
  value: string;
}

export interface AiProviderKey {
  mode: 'gcm' | 'plain';
  iv?: string;
  ct: string;
}

export interface AiProviderConfig {
  id: string;
  name: string;
  kind: AiProviderKind;
  /** Normalized without trailing slashes before persistence. */
  baseUrl: string;
  model?: string;
  /** Extra request headers. Values may contain the literal placeholder {{apiKey}}. */
  headers?: AiProviderHeader[];
  /**
   * Which capabilities this service actually offers. A custom HTTP service is often
   * chat-only (or speech-only, etc.) — nodes only offer providers that support their
   * capability, and resolution refuses the rest. `undefined` = all three (legacy
   * records saved before this field existed, and full-surface providers like OpenAI).
   */
  capabilities?: AiCapability[];
  chatPath?: string;
  transcriptionPath?: string;
  speechPath?: string;
  requestTemplate?: string;
  responsePath?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  encryptedKey?: AiProviderKey;
}

export const AI_CAPABILITIES: AiCapability[] = ['chat', 'transcription', 'speech'];

export const AI_CAPABILITY_LABELS: Record<AiCapability, string> = {
  chat: 'Chat',
  transcription: 'Transcription',
  speech: 'Speech',
};

/** Does this provider offer the capability? Absent list = all three (legacy records). */
export function providerSupports(cfg: Pick<AiProviderConfig, 'capabilities'>, capability: AiCapability): boolean {
  return !Array.isArray(cfg.capabilities) || cfg.capabilities.includes(capability);
}

export interface ResolvedAiProvider {
  name: string;
  kind: AiProviderKind;
  url: string;
  headers: Record<string, string>;
  model?: string;
  requestTemplate?: string;
  responsePath?: string;
  /** True when a saved key was intentionally withheld for http:// on a non-loopback host. */
  keyBlocked?: boolean;
  /** Browser-only secret for request templates; never comes from flow JSON. */
  apiKey?: string;
}

interface AiProviderPreset {
  label: string;
  description: string;
  defaults: Pick<AiProviderConfig, 'kind' | 'baseUrl' | 'enabled'> & Partial<AiProviderConfig>;
  keyRequired: boolean;
  corsHint: string;
}

const DEFAULT_CHAT_PATH = '/chat/completions';
const DEFAULT_TRANSCRIPTION_PATH = '/audio/transcriptions';
const DEFAULT_SPEECH_PATH = '/audio/speech';
const DEFAULT_RESPONSE_PATH = 'choices.0.message.content';

export const AI_PROVIDER_PRESETS: Record<AiProviderKind, AiProviderPreset> = {
  openai: {
    label: 'OpenAI',
    description: 'OpenAI-hosted chat, transcription and speech APIs.',
    defaults: {
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      // No default model on purpose: model names churn too fast to hardcode.
      // The editor's "Fetch models" helper lists what the account can use.
      capabilities: ['chat', 'transcription', 'speech'],
      enabled: true,
      chatPath: DEFAULT_CHAT_PATH,
      transcriptionPath: DEFAULT_TRANSCRIPTION_PATH,
      speechPath: DEFAULT_SPEECH_PATH,
      responsePath: DEFAULT_RESPONSE_PATH,
    },
    keyRequired: true,
    corsHint: 'None',
  },
  ollama: {
    label: 'Ollama',
    description: 'Local OpenAI-compatible Ollama server.',
    defaults: {
      kind: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      capabilities: ['chat'],
      enabled: true,
      chatPath: DEFAULT_CHAT_PATH,
      transcriptionPath: DEFAULT_TRANSCRIPTION_PATH,
      speechPath: DEFAULT_SPEECH_PATH,
      responsePath: DEFAULT_RESPONSE_PATH,
    },
    keyRequired: false,
    corsHint: 'Set OLLAMA_ORIGINS to this site origin.',
  },
  lmstudio: {
    label: 'LM Studio',
    description: 'Local OpenAI-compatible LM Studio server.',
    defaults: {
      kind: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      capabilities: ['chat'],
      enabled: true,
      chatPath: DEFAULT_CHAT_PATH,
      transcriptionPath: DEFAULT_TRANSCRIPTION_PATH,
      speechPath: DEFAULT_SPEECH_PATH,
      responsePath: DEFAULT_RESPONSE_PATH,
    },
    keyRequired: false,
    corsHint: 'Enable CORS in the server settings.',
  },
  custom: {
    label: 'Custom HTTP',
    description: 'A browser-local custom HTTP provider with templated JSON requests.',
    defaults: {
      kind: 'custom',
      baseUrl: '',
      capabilities: ['chat'],
      enabled: true,
      chatPath: DEFAULT_CHAT_PATH,
      transcriptionPath: DEFAULT_TRANSCRIPTION_PATH,
      speechPath: DEFAULT_SPEECH_PATH,
      responsePath: DEFAULT_RESPONSE_PATH,
    },
    keyRequired: false,
    corsHint: 'Configure CORS on the provider server for this site origin.',
  },
};

export const PRESETS = AI_PROVIDER_PRESETS;

interface ProviderStore {
  v: 1;
  providers: AiProviderConfig[];
}

const STORAGE_PREFIX = 'formlogic-ai-services';
const STORE_VERSION = 1;

// Deliberately not purged on logout: users require browser-held AI keys to survive.
// Per-user namespacing prevents the next signed-in user from seeing another account's services.
const storageKeyFor = (userId: string | null | undefined) => `${STORAGE_PREFIX}:${normalizeUserId(userId)}`;

function normalizeUserId(userId: string | null | undefined): string {
  return typeof userId === 'string' && userId.trim() !== '' ? userId.trim() : 'anon';
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function normalizePath(path: unknown, fallback: string): string {
  const raw = typeof path === 'string' && path.trim() !== '' ? path.trim() : fallback;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function normalizeProvider(cfg: AiProviderConfig): AiProviderConfig {
  const headers = Array.isArray(cfg.headers)
    ? cfg.headers
        .filter((h) => h && typeof h.name === 'string' && h.name.trim() !== '' && typeof h.value === 'string')
        .map((h) => ({ name: h.name.trim(), value: h.value }))
    : undefined;
  const capabilities = Array.isArray(cfg.capabilities)
    ? cfg.capabilities.filter((c): c is AiCapability => AI_CAPABILITIES.includes(c as AiCapability))
    : undefined;
  return {
    ...cfg,
    id: cfg.id.trim(),
    name: cfg.name.trim(),
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    // An empty/invalid list degrades to undefined (= all) rather than a useless
    // provider no node could ever pick; the editor blocks saving zero capabilities.
    capabilities: capabilities && capabilities.length > 0 ? capabilities : undefined,
    model: typeof cfg.model === 'string' && cfg.model.trim() !== '' ? cfg.model.trim() : undefined,
    headers,
    chatPath: cfg.chatPath ? normalizePath(cfg.chatPath, DEFAULT_CHAT_PATH) : undefined,
    transcriptionPath: cfg.transcriptionPath ? normalizePath(cfg.transcriptionPath, DEFAULT_TRANSCRIPTION_PATH) : undefined,
    speechPath: cfg.speechPath ? normalizePath(cfg.speechPath, DEFAULT_SPEECH_PATH) : undefined,
    requestTemplate: typeof cfg.requestTemplate === 'string' && cfg.requestTemplate.trim() !== '' ? cfg.requestTemplate : undefined,
    responsePath: typeof cfg.responsePath === 'string' && cfg.responsePath.trim() !== '' ? cfg.responsePath.trim() : undefined,
    enabled: cfg.enabled,
  };
}

function readStore(userId: string | null | undefined): ProviderStore {
  try {
    const raw = localStorage.getItem(storageKeyFor(userId));
    if (!raw) return { v: STORE_VERSION, providers: [] };
    const parsed = JSON.parse(raw) as Partial<ProviderStore>;
    if (parsed.v !== STORE_VERSION || !Array.isArray(parsed.providers)) return { v: STORE_VERSION, providers: [] };
    return { v: STORE_VERSION, providers: parsed.providers.filter(isProviderConfig).map(normalizeProvider) };
  } catch {
    return { v: STORE_VERSION, providers: [] };
  }
}

function writeStore(userId: string | null | undefined, store: ProviderStore): void {
  try {
    localStorage.setItem(storageKeyFor(userId), JSON.stringify(store));
  } catch {
    // localStorage may be unavailable or full; browser-only provider storage is best-effort.
  }
}

function isProviderConfig(value: unknown): value is AiProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cfg = value as Partial<AiProviderConfig>;
  return (
    typeof cfg.id === 'string' &&
    typeof cfg.name === 'string' &&
    typeof cfg.kind === 'string' &&
    ['openai', 'ollama', 'lmstudio', 'custom'].includes(cfg.kind) &&
    typeof cfg.baseUrl === 'string' &&
    typeof cfg.enabled === 'boolean' &&
    typeof cfg.createdAt === 'string' &&
    typeof cfg.updatedAt === 'string'
  );
}

function writeProvider(userId: string | null | undefined, cfg: AiProviderConfig, preserveExistingKey: boolean): void {
  const store = readStore(userId);
  const existingIndex = store.providers.findIndex((p) => p.id === cfg.id);
  const existing = existingIndex >= 0 ? store.providers[existingIndex] : null;
  const normalized = normalizeProvider(cfg);
  if (preserveExistingKey && !normalized.encryptedKey && existing?.encryptedKey) {
    normalized.encryptedKey = existing.encryptedKey;
  }
  if (existingIndex >= 0) store.providers[existingIndex] = normalized;
  else store.providers.push(normalized);
  writeStore(userId, store);
}

export function listProviders(userId: string | null | undefined): AiProviderConfig[] {
  return readStore(userId).providers;
}

export function saveProvider(userId: string | null | undefined, cfg: AiProviderConfig): void {
  writeProvider(userId, cfg, true);
}

export function deleteProvider(userId: string | null | undefined, id: string): void {
  const store = readStore(userId);
  writeStore(userId, { v: STORE_VERSION, providers: store.providers.filter((p) => p.id !== id) });
}

export function getProvider(userId: string | null | undefined, id: string): AiProviderConfig | null {
  return readStore(userId).providers.find((p) => p.id === id) ?? null;
}

type ProviderJsonShape = Partial<Omit<AiProviderConfig, 'encryptedKey'>> & {
  formlogicAiService?: unknown;
  encryptedKey?: unknown;
};

const PROVIDER_IMPORT_MARKER = 1;

function providerJsonShape(cfg: AiProviderConfig): ProviderJsonShape {
  const out: ProviderJsonShape = {
    formlogicAiService: PROVIDER_IMPORT_MARKER,
    id: cfg.id,
    name: cfg.name,
    kind: cfg.kind,
    baseUrl: cfg.baseUrl,
    enabled: cfg.enabled,
  };
  if (cfg.model !== undefined) out.model = cfg.model;
  if (cfg.headers !== undefined) out.headers = cfg.headers;
  if (cfg.capabilities !== undefined) out.capabilities = cfg.capabilities;
  if (cfg.chatPath !== undefined) out.chatPath = cfg.chatPath;
  if (cfg.transcriptionPath !== undefined) out.transcriptionPath = cfg.transcriptionPath;
  if (cfg.speechPath !== undefined) out.speechPath = cfg.speechPath;
  if (cfg.requestTemplate !== undefined) out.requestTemplate = cfg.requestTemplate;
  if (cfg.responsePath !== undefined) out.responsePath = cfg.responsePath;
  return out;
}

export function exportProviderJson(cfg: AiProviderConfig): string {
  return JSON.stringify(providerJsonShape(cfg), null, 2);
}

function parseProviderObject(value: unknown, index: number): AiProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`AI service import item ${index + 1} must be an object.`);
  }
  const raw = value as ProviderJsonShape;
  if (raw.formlogicAiService !== PROVIDER_IMPORT_MARKER) {
    throw new Error(`AI service import item ${index + 1} is missing the FormLogic AI service marker.`);
  }
  if (typeof raw.id !== 'string' || raw.id.trim() === '') throw new Error(`AI service import item ${index + 1} needs an id.`);
  if (typeof raw.name !== 'string' || raw.name.trim() === '') throw new Error(`AI service import item ${index + 1} needs a name.`);
  if (typeof raw.kind !== 'string' || !['openai', 'ollama', 'lmstudio', 'custom'].includes(raw.kind)) {
    throw new Error(`AI service import item ${index + 1} has an unsupported kind.`);
  }
  if (typeof raw.baseUrl !== 'string') throw new Error(`AI service import item ${index + 1} needs a baseUrl.`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error(`AI service import item ${index + 1} has an invalid enabled value.`);
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') throw new Error(`AI service import item ${index + 1} has an invalid model.`);
  if (raw.capabilities !== undefined) {
    if (
      !Array.isArray(raw.capabilities) ||
      raw.capabilities.length === 0 ||
      !raw.capabilities.every((c) => typeof c === 'string' && AI_CAPABILITIES.includes(c as AiCapability))
    ) {
      throw new Error(`AI service import item ${index + 1} has invalid capabilities (allowed: chat, transcription, speech).`);
    }
  }
  if (raw.chatPath !== undefined && typeof raw.chatPath !== 'string') throw new Error(`AI service import item ${index + 1} has an invalid chatPath.`);
  if (raw.transcriptionPath !== undefined && typeof raw.transcriptionPath !== 'string') {
    throw new Error(`AI service import item ${index + 1} has an invalid transcriptionPath.`);
  }
  if (raw.speechPath !== undefined && typeof raw.speechPath !== 'string') throw new Error(`AI service import item ${index + 1} has an invalid speechPath.`);
  if (raw.requestTemplate !== undefined && typeof raw.requestTemplate !== 'string') {
    throw new Error(`AI service import item ${index + 1} has an invalid requestTemplate.`);
  }
  if (raw.responsePath !== undefined && typeof raw.responsePath !== 'string') {
    throw new Error(`AI service import item ${index + 1} has an invalid responsePath.`);
  }
  if (raw.headers !== undefined) {
    if (!Array.isArray(raw.headers)) throw new Error(`AI service import item ${index + 1} has invalid headers.`);
    for (const header of raw.headers) {
      if (!header || typeof header !== 'object' || Array.isArray(header)) {
        throw new Error(`AI service import item ${index + 1} has invalid headers.`);
      }
      const h = header as Partial<AiProviderHeader>;
      if (typeof h.name !== 'string' || typeof h.value !== 'string') {
        throw new Error(`AI service import item ${index + 1} has invalid headers.`);
      }
    }
  }

  const now = new Date().toISOString();
  return normalizeProvider({
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    baseUrl: raw.baseUrl,
    model: raw.model,
    headers: raw.headers,
    capabilities: raw.capabilities as AiCapability[] | undefined,
    chatPath: raw.chatPath,
    transcriptionPath: raw.transcriptionPath,
    speechPath: raw.speechPath,
    requestTemplate: raw.requestTemplate,
    responsePath: raw.responsePath,
    enabled: raw.enabled ?? true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  });
}

export function parseProviderImport(text: string): AiProviderConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`AI service import must be valid JSON: ${reason}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) throw new Error('AI service import did not contain any services.');
  return items.map(parseProviderObject);
}

const VAULT_DB_NAME = 'formlogic-ai-vault';
const VAULT_STORE = 'keys';
const VAULT_KEY_ID = 'vault-key';

function hasEncryptedVaultApis(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    !!crypto.subtle &&
    typeof crypto.getRandomValues === 'function'
  );
}

export function vaultMode(): 'encrypted' | 'plain' {
  return hasEncryptedVaultApis() ? 'encrypted' : 'plain';
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open AI provider key vault'));
  });
}

function idbGetVaultKey(db: IDBDatabase): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(VAULT_STORE, 'readonly').objectStore(VAULT_STORE).get(VAULT_KEY_ID);
    req.onsuccess = () => {
      const result = req.result as { key?: CryptoKey } | undefined;
      resolve(result?.key ?? null);
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to read AI provider key vault'));
  });
}

function idbPutVaultKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(VAULT_STORE, 'readwrite').objectStore(VAULT_STORE).put({ id: VAULT_KEY_ID, key });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Failed to write AI provider key vault'));
  });
}

async function getOrCreateVaultKey(): Promise<CryptoKey | null> {
  if (!hasEncryptedVaultApis()) return null;
  const db = await openVaultDb();
  try {
    const existing = await idbGetVaultKey(db);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbPutVaultKey(db, key);
    return key;
  } finally {
    db.close();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  if (typeof btoa === 'function') return btoa(binary);
  return (globalThis as { Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } } })
    .Buffer!.from(binary, 'binary')
    .toString('base64');
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = typeof atob === 'function'
    ? atob(base64)
    : (globalThis as { Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } } })
        .Buffer!.from(base64, 'base64')
        .toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function base64ToUtf8(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function plainSeal(value: string): AiProviderKey {
  // Insecure origins such as http://formlogic.local do not expose crypto.subtle.
  // Store base64 plaintext in that case; AES-GCM is hardening, not a security boundary.
  return { mode: 'plain', ct: utf8ToBase64(value) };
}

async function sealProviderKey(value: string): Promise<AiProviderKey> {
  try {
    const key = await getOrCreateVaultKey();
    if (!key) return plainSeal(value);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(new TextEncoder().encode(value))
    );
    return { mode: 'gcm', iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
  } catch {
    return plainSeal(value);
  }
}

async function openProviderKey(record: AiProviderKey): Promise<string | null> {
  try {
    if (record.mode === 'plain') return base64ToUtf8(record.ct);
    if (!record.iv) return null;
    const key = await getOrCreateVaultKey();
    if (!key) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(record.iv)) },
      key,
      toArrayBuffer(base64ToBytes(record.ct))
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function setProviderKey(userId: string | null | undefined, providerId: string, key: string): Promise<void> {
  const provider = getProvider(userId, providerId);
  if (!provider) return;
  if (key === '') {
    clearProviderKey(userId, providerId);
    return;
  }
  writeProvider(userId, { ...provider, encryptedKey: await sealProviderKey(key), updatedAt: new Date().toISOString() }, false);
}

export async function getProviderKey(userId: string | null | undefined, providerId: string): Promise<string | null> {
  const provider = getProvider(userId, providerId);
  if (!provider?.encryptedKey) return null;
  return openProviderKey(provider.encryptedKey);
}

export function clearProviderKey(userId: string | null | undefined, providerId: string): void {
  const provider = getProvider(userId, providerId);
  if (!provider) return;
  const next = { ...provider, updatedAt: new Date().toISOString() };
  delete next.encryptedKey;
  writeProvider(userId, next, false);
}

function pathForCapability(provider: AiProviderConfig, capability: AiCapability): string {
  if (capability === 'transcription') return normalizePath(provider.transcriptionPath, DEFAULT_TRANSCRIPTION_PATH);
  if (capability === 'speech') return normalizePath(provider.speechPath, DEFAULT_SPEECH_PATH);
  return normalizePath(provider.chatPath, DEFAULT_CHAT_PATH);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

function blocksKeyOverHttp(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : undefined);
    return parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname);
  } catch {
    return true;
  }
}

function hasApiKeyPlaceholder(value: string): boolean {
  return value.includes('{{apiKey}}');
}

export async function resolveProviderRequest(
  userId: string | null | undefined,
  capability: AiCapability,
  providerId: string
): Promise<ResolvedAiProvider | null> {
  const provider = getProvider(userId, providerId);
  if (!provider || !provider.enabled || provider.baseUrl.trim() === '') return null;
  // A provider that doesn't offer this capability resolves to null — the node
  // surfaces the same actionable "not configured" failure as an unknown id.
  if (!providerSupports(provider, capability)) return null;

  const url = `${normalizeBaseUrl(provider.baseUrl)}${pathForCapability(provider, capability)}`;
  const savedKey = await getProviderKey(userId, providerId);
  const keyBlocked = !!savedKey && blocksKeyOverHttp(url);
  const keyForRequest = savedKey && !keyBlocked ? savedKey : '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let headerReferencedKey = false;

  for (const header of provider.headers ?? []) {
    const nameHasKey = hasApiKeyPlaceholder(header.name);
    const valueHasKey = hasApiKeyPlaceholder(header.value);
    if (nameHasKey || valueHasKey) headerReferencedKey = true;
    if (keyBlocked && (nameHasKey || valueHasKey)) continue;
    const name = header.name.replaceAll('{{apiKey}}', keyForRequest).trim();
    if (name !== '') headers[name] = header.value.replaceAll('{{apiKey}}', keyForRequest);
  }

  if (savedKey && !headerReferencedKey && !keyBlocked) headers.Authorization = `Bearer ${savedKey}`;

  return {
    name: provider.name,
    kind: provider.kind,
    url,
    headers,
    model: provider.model,
    requestTemplate: provider.requestTemplate,
    responsePath: provider.responsePath ?? DEFAULT_RESPONSE_PATH,
    keyBlocked: keyBlocked || undefined,
    apiKey: keyForRequest || undefined,
  };
}

export function extractByPath(obj: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === '') return obj;
  let current = obj;
  for (const segment of trimmed.split('.')) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export interface AiRequestTemplateVars {
  model?: unknown;
  prompt?: unknown;
  system?: unknown;
  messages?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  input?: unknown;
  voice?: unknown;
  audio?: unknown;
  apiKey?: unknown;
}

const TEMPLATE_KEYS = new Set<keyof AiRequestTemplateVars>([
  'model',
  'prompt',
  'system',
  'messages',
  'temperature',
  'maxTokens',
  'input',
  'voice',
  'audio',
  'apiKey',
]);

/**
 * Render a JSON request body template and return the parsed value.
 *
 * Preferred convention: write placeholders as bare JSON values, e.g.
 * `{"model": {{model}}, "messages": {{messages}}}`. Bare placeholders are replaced
 * with `JSON.stringify(value)`, so strings, arrays and objects remain valid JSON.
 * Placeholders inside an existing JSON string are also supported; their values are escaped
 * as string content instead. A rendered template must parse as JSON or this throws.
 */
export function renderRequestTemplate(template: string, vars: AiRequestTemplateVars): unknown {
  const rendered = template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match, key: string, offset: number, source: string) => {
    if (!TEMPLATE_KEYS.has(key as keyof AiRequestTemplateVars)) return match;
    const value = vars[key as keyof AiRequestTemplateVars];
    if (isInsideJsonString(source, offset)) return jsonStringContent(value);
    const json = JSON.stringify(value === undefined ? null : value);
    return json === undefined ? 'null' : json;
  });
  try {
    return JSON.parse(rendered);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`AI provider request template must render to valid JSON: ${reason}`);
  }
}

function jsonStringContent(value: unknown): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  const json = JSON.stringify(raw ?? '');
  return json.slice(1, -1);
}

function isInsideJsonString(source: string, offset: number): boolean {
  let inString = false;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] !== '"' || isEscapedQuote(source, i)) continue;
    inString = !inString;
  }
  return inString;
}

function isEscapedQuote(source: string, quoteIndex: number): boolean {
  let slashes = 0;
  for (let i = quoteIndex - 1; i >= 0 && source[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}
