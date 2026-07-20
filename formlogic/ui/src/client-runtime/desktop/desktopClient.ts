// FormLogic Desktop typed HTTP client (docs/FORMLOGIC_DESKTOP.md §2/§3).
//
// A thin fetch wrapper over the token-gated desktop API. Every call resolves a
// DesktopClientResult — it NEVER throws:
//   - network failure / timeout / non-JSON  → {ok:false, error:{code:'connector_unavailable'},
//     transportFailure:true} (the client-synthesised flavour — Desktop unreachable, safe
//     for a caller to treat as "absent");
//   - HTTP 401                              → {ok:false, error:{code:'auth_required'}} and the
//     stored pairing token is dropped (contract: auth_required is desktop-transport-only and
//     is handled HERE, before the connector layer — it never surfaces as a ConnectorError);
//   - a desktop-returned error envelope     → passed through verbatim ({ok:false, error:{code,…}}).
import {
  getDesktopBaseUrl,
  type DesktopClientResult,
  type DesktopConnectorRequestBody,
  type DesktopConnectorStatus,
  type DesktopConnectorSummary,
  type DesktopErrorShape,
  type DesktopPluginSummary,
  type DesktopTrustedOrigin,
} from './desktopTypes';
import { clearDesktopToken, desktopAuthHeaders } from './desktopPairing';
import { resolveBackendApiUrl } from '../../lib/apiBase';

const FETCH_TIMEOUT_MS = 10_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? (AbortSignal as unknown as { timeout: (n: number) => AbortSignal }).timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

function isErrorShape(value: unknown): value is DesktopErrorShape {
  const v = value as { code?: unknown; message?: unknown } | null;
  return !!v && typeof v === 'object' && typeof v.code === 'string' && typeof v.message === 'string';
}

/**
 * One token-authenticated desktop call. Resolves the parsed JSON body as `data` on
 * success; all failure modes collapse to the typed error envelope described above.
 */
async function desktopFetch<T>(path: string, init: RequestInit = {}): Promise<DesktopClientResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${getDesktopBaseUrl()}${path}`, {
      credentials: 'omit',
      cache: 'no-store',
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
      ...init,
      headers: {
        Accept: 'application/json',
        // Let fetch add multipart boundaries for FormData (and the correct
        // media type for other native body types). All JSON callers in this
        // client pass a serialized string and may still override this header.
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...desktopAuthHeaders(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'connector_unavailable',
        message: e instanceof Error ? e.message : 'FormLogic Desktop is not reachable.',
      },
      transportFailure: true,
    };
  }

  const body = (await res.json().catch(() => null)) as unknown;

  if (res.status === 401) {
    // Missing/expired pairing token. Drop it so the UI flips to "not paired" and offers
    // to re-pair; per contract this code never reaches the connector layer.
    clearDesktopToken();
    const err = (body as { error?: unknown } | null)?.error;
    return {
      ok: false,
      error: isErrorShape(err) ? err : { code: 'auth_required', message: 'Pairing with FormLogic Desktop is required.' },
    };
  }

  // A desktop-returned typed error envelope ({ok:false, error:{code,message}}) wins at any status.
  const asEnvelope = body as { ok?: unknown; error?: unknown } | null;
  if (asEnvelope && asEnvelope.ok === false && isErrorShape(asEnvelope.error)) {
    return { ok: false, error: asEnvelope.error };
  }

  if (!res.ok || body === null) {
    return {
      ok: false,
      error: { code: 'command_failed', message: `FormLogic Desktop responded ${res.status}.` },
      ...(body === null && res.ok ? { transportFailure: true as const } : {}),
    };
  }

  return { ok: true, data: body as T };
}

/** Accept both `[...]` and `{key:[...]}` list shapes (the contract doesn't pin the wrapper). */
function unwrapList<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const wrapped = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

function mapList<T>(res: DesktopClientResult<unknown>, key: string): DesktopClientResult<T[]> {
  if (!res.ok) return res;
  return { ok: true, data: unwrapList<T>(res.data, key) };
}

export interface DesktopInstanceInfo {
  name?: string;
  version?: string;
  platform?: string;
  apiVersion?: number;
  pluginApiVersion?: number;
  /** Stable id of this Desktop install, when the build provides one. */
  instanceId?: string;
  /** Headless flow runtime status (linked, errors, relay poll). */
  flowRuntime?: {
    linked?: boolean;
    errors?: number;
    lastError?: string | null;
    relayPollOk?: boolean | null;
  };
  /**
   * The aokie plugin's last TRUTHFUL health report (audit INT-006/C-15):
   * status 'ok' | 'degraded' | 'error' | 'unreachable' with the reasons —
   * lets "Listening" say why the receptionist is impaired.
   */
  aokiePluginHealth?: {
    ok?: boolean;
    status?: string;
    detail?: string | null;
    at?: string;
  };
}

/** A template-declared call contract for a Desktop-managed service (ServiceSnapshot.node). */
export interface DesktopServiceNodeSpec {
  endpoint?: string | null;
  method?: string | null;
  bodyTemplate?: string | null;
  responsePath?: string | null;
  /** 'openai' = OpenAI-compatible chat endpoint (llama.cpp, Ollama, LM Studio, vLLM, TGI). */
  apiFormat?: string | null;
  icon?: string | null;
}

/** Subset of Desktop's ServiceSnapshot (GET /api/services → RegistrySnapshot.services). */
export interface DesktopServiceSnapshot {
  id: string;
  name: string;
  description?: string;
  category?: string;
  status: string;
  port: number;
  defaultPort?: number;
  docsUrl?: string | null;
  /** How to call this service as a node, declared by its template (optional). */
  node?: DesktopServiceNodeSpec | null;
}

/**
 * One row of GET /api/ai/sources (SRC-202) — the union of everything a
 * model/voice lane picker can point at: local service instances (live status,
 * port, configured model) and configured AI providers (key/capability state,
 * never secrets). `id` is already prefixed (`service:<id>` / `provider:<id>`).
 */
export interface DesktopAiSource {
  id: string;
  kind: 'service' | 'provider';
  serviceId?: string;
  providerId?: string;
  name?: string;
  category?: string;
  status?: string;
  installed?: boolean;
  port?: number;
  url?: string;
  model?: string | null;
  /** NOTE: an EMPTY provider capability set means "all" (legacy profiles). */
  capabilities?: string[];
  /**
   * Surfaces this source is intended to serve. Older Desktop builds omit this
   * field, which consumers treat as unrestricted for compatibility.
   */
  useCases?: string[];
  protocol?: string;
  hasKey?: boolean;
  enabled?: boolean;
}

/** One OpenAI-compatible chat message accepted by the Desktop AI gateway. */
export interface DesktopAiChatMessage {
  role: string;
  content: string;
}

/**
 * Canonical request sent to Desktop's AI gateway. Extra OpenAI-compatible
 * fields are intentionally retained so flow-node `extraBody` settings survive
 * the browser -> Desktop hop. Provider credentials are never part of this body.
 */
export interface DesktopAiChatRequest {
  messages: DesktopAiChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

/** Multipart transcription input; the audio bytes never pass through FormLogic Cloud. */
export interface DesktopAiTranscriptionRequest {
  file: Blob;
  /** Overrides File.name; used when a recorder supplies an unnamed Blob. */
  filename?: string;
  model?: string;
  language?: string;
  prompt?: string;
  /** JSON formats retain the typed `{text}` response contract used by this client. */
  responseFormat?: 'json' | 'verbose_json' | 'diarized_json';
  temperature?: number;
  timestampGranularities?: string[];
  /** OpenAI multipart value, for example `auto` or a JSON-encoded strategy. */
  chunkingStrategy?: string;
}

export interface DesktopAiTranscriptionResponse {
  text: string;
  [key: string]: unknown;
}

export interface DesktopAiAudioInput {
  /** Base64-encoded audio; provider credentials remain Desktop-only. */
  data: string;
  format: string;
}

export type DesktopAiAudioChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'input_audio'; input_audio: DesktopAiAudioInput };

export interface DesktopAiAudioChatMessage {
  role: string;
  content: string | DesktopAiAudioChatContentPart[];
}

export interface DesktopAiAudioChatRequest {
  messages: DesktopAiAudioChatMessage[];
  model?: string;
  modalities?: Array<'text' | 'audio'>;
  audio?: { voice?: string; format?: string; [key: string]: unknown };
  /** The typed client returns one buffered JSON response; use Realtime for streaming audio. */
  stream?: false;
  [key: string]: unknown;
}

export interface DesktopAiAudioChatResponse {
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      audio?: {
        id?: string;
        data?: string;
        transcript?: string;
        expires_at?: number;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    finish_reason?: string | null;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** Browser SDP offer brokered by Desktop so the OpenAI API key is never exposed. */
export interface DesktopAiRealtimeSessionRequest {
  sdp: string;
  /** Optional full Realtime session object; shortcuts below are merged into it. */
  session?: Record<string, unknown>;
  model?: string;
  voice?: string;
  instructions?: string;
  [key: string]: unknown;
}

export interface DesktopAiRealtimeSessionResponse {
  sdp: string;
  [key: string]: unknown;
}

/** Secret-free model metadata returned by Desktop's authenticated gateway. */
export interface DesktopAiModel {
  id: string;
  object?: string;
  owned_by?: string;
  [key: string]: unknown;
}

export interface DesktopServiceDefinitionAction {
  id: string;
  title: string;
  description?: string;
  category?: { id: string; label: string };
  tags: string[];
  capability?: string;
  sideEffects?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** Credential-free ServiceDefinition projection exposed to the paired website. */
export interface DesktopServiceDefinition {
  schemaVersion: number;
  id: string;
  version: string;
  name: string;
  description: string;
  kind: string;
  category: { id: string; label: string };
  tags: string[];
  capabilities: string[];
  settingsSchema?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  actions: DesktopServiceDefinitionAction[];
}

export interface DesktopServiceCatalog {
  schemaVersion: number;
  definitions: DesktopServiceDefinition[];
}

export interface DesktopCodexAccount {
  accountType: string;
  email?: string;
  planType?: string;
}

export interface DesktopCodexStatus {
  available: boolean;
  running: boolean;
  version?: string;
  requiresOpenaiAuth: boolean;
  account?: DesktopCodexAccount;
  safeDefaults: {
    fileSystem: string;
    network: string;
    approvals: string;
    credentials: string;
  };
  error?: string;
}

export interface DesktopCodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: unknown[];
}

export interface DesktopCodexChatRequest {
  prompt: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface DesktopCodexChatResponse {
  threadId: string;
  turnId: string;
  text: string;
}

/** Normalized OpenAI-compatible chunk delivered by the SSE gateway. */
export interface DesktopAiChatStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string; [key: string]: unknown };
    finish_reason?: string | null;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface DesktopAiChatStreamSummary {
  chunks: number;
  bytes: number;
  sawDone: boolean;
}

export interface DesktopAiChatStreamOptions {
  onChunk: (chunk: DesktopAiChatStreamChunk) => void | Promise<void>;
  signal?: AbortSignal;
  /** Total stream deadline; clamped to 1s..5m. Defaults to 125s. */
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function aiGatewayPath(providerId: string | undefined, suffix: string): string {
  return providerId
    ? `/api/ai/providers/${encodeURIComponent(providerId)}/v1/${suffix}`
    : `/api/ai/v1/${suffix}`;
}

function aiCapabilityService(providerId?: string): 'openai-api' | 'openai-codex-agent' {
  // The generic background adapter spends the linked ChatGPT/Codex account,
  // not an OpenAI Platform key. Ask the server for that service's exact grant
  // so middleware cannot mistake one billing/auth domain for the other.
  return providerId === 'openai-codex-agent' ? 'openai-codex-agent' : 'openai-api';
}

function mapRequiredStringObject<T extends Record<string, unknown>>(
  result: DesktopClientResult<unknown>,
  field: string,
  invalidMessage: string
): DesktopClientResult<T> {
  if (!result.ok) return result;
  const value = asRecord(result.data);
  if (!value || typeof value[field] !== 'string') {
    return { ok: false, error: { code: 'command_failed', message: invalidMessage } };
  }
  return { ok: true, data: value as T };
}

function transcriptionFormData(input: DesktopAiTranscriptionRequest): FormData {
  const form = new FormData();
  const namedBlob = input.file as Blob & { name?: unknown };
  const inheritedName = typeof namedBlob.name === 'string' && namedBlob.name.trim() !== ''
    ? namedBlob.name.trim()
    : 'audio.wav';
  const filename = input.filename?.trim() || inheritedName;
  form.append('file', input.file, filename);
  if (input.model) form.append('model', input.model);
  if (input.language) form.append('language', input.language);
  if (input.prompt) form.append('prompt', input.prompt);
  if (input.responseFormat) form.append('response_format', input.responseFormat);
  if (input.temperature !== undefined) form.append('temperature', String(input.temperature));
  if (input.chunkingStrategy) form.append('chunking_strategy', input.chunkingStrategy);
  for (const granularity of input.timestampGranularities ?? []) {
    form.append('timestamp_granularities[]', granularity);
  }
  return form;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function definitionCategory(value: unknown): { id: string; label: string } | null {
  const category = asRecord(value);
  return category && typeof category.id === 'string' && typeof category.label === 'string'
    ? { id: category.id, label: category.label }
    : null;
}

/**
 * Project the Desktop catalog onto the website-safe contract. In particular,
 * transport internals (including stdio JSON-RPC method names) and auth details
 * are not copied into the browser-facing value.
 */
function safeServiceDefinition(value: unknown): DesktopServiceDefinition | null {
  const definition = asRecord(value);
  const category = definitionCategory(definition?.category);
  if (
    !definition ||
    typeof definition.schemaVersion !== 'number' ||
    typeof definition.id !== 'string' ||
    typeof definition.version !== 'string' ||
    typeof definition.name !== 'string' ||
    typeof definition.description !== 'string' ||
    typeof definition.kind !== 'string' ||
    !category
  ) return null;

  const actions = Array.isArray(definition.actions)
    ? definition.actions.flatMap((rawAction): DesktopServiceDefinitionAction[] => {
        const action = asRecord(rawAction);
        if (!action || typeof action.id !== 'string' || typeof action.title !== 'string') return [];
        const actionCategory = definitionCategory(action.category);
        const inputSchema = asRecord(action.inputSchema);
        const outputSchema = asRecord(action.outputSchema);
        return [{
          id: action.id,
          title: action.title,
          ...(typeof action.description === 'string' ? { description: action.description } : {}),
          ...(actionCategory ? { category: actionCategory } : {}),
          tags: stringArray(action.tags),
          ...(typeof action.capability === 'string' ? { capability: action.capability } : {}),
          ...(typeof action.sideEffects === 'string' ? { sideEffects: action.sideEffects } : {}),
          ...(inputSchema ? { inputSchema } : {}),
          ...(outputSchema ? { outputSchema } : {}),
        }];
      })
    : [];
  const settingsSchema = asRecord(definition.settingsSchema);
  const ui = asRecord(definition.ui);
  return {
    schemaVersion: definition.schemaVersion,
    id: definition.id,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    kind: definition.kind,
    category,
    tags: stringArray(definition.tags),
    capabilities: stringArray(definition.capabilities),
    ...(settingsSchema ? { settingsSchema } : {}),
    ...(ui ? { ui } : {}),
    actions,
  };
}

function mapServiceCatalog(res: DesktopClientResult<unknown>): DesktopClientResult<DesktopServiceCatalog> {
  if (!res.ok) return res;
  const body = asRecord(res.data);
  if (!body || typeof body.schemaVersion !== 'number' || !Array.isArray(body.definitions)) {
    return { ok: false, error: { code: 'command_failed', message: 'Desktop returned an invalid service catalog.' } };
  }
  const definitions = body.definitions.map(safeServiceDefinition);
  if (definitions.some((definition) => definition === null)) {
    return { ok: false, error: { code: 'command_failed', message: 'Desktop returned an invalid service definition.' } };
  }
  return { ok: true, data: { schemaVersion: body.schemaVersion, definitions: definitions as DesktopServiceDefinition[] } };
}

const MAX_SSE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 512 * 1024;
const MAX_SSE_LINE_BUFFER_CHARS = 512 * 1024;
const MAX_SSE_EVENTS = 100_000;
const MAX_STREAM_ERROR_BODY_BYTES = 64 * 1024;
const DEFAULT_STREAM_TIMEOUT_MS = 125_000;

class DesktopSseProtocolError extends Error {}
class DesktopSseConsumerError extends Error {}
class DesktopSseUpstreamError extends Error {}

interface DesktopSseFrame {
  done: boolean;
  data?: string;
}

class DesktopSseParser {
  private lineBuffer = '';
  private dataLines: string[] = [];
  private eventChars = 0;
  private eventCount = 0;

  push(text: string): DesktopSseFrame[] {
    this.lineBuffer += text;
    const frames: DesktopSseFrame[] = [];
    let newline = this.lineBuffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.consumeLine(line, frames);
      newline = this.lineBuffer.indexOf('\n');
    }
    if (this.lineBuffer.length > MAX_SSE_LINE_BUFFER_CHARS) {
      throw new DesktopSseProtocolError('SSE line exceeded the browser limit.');
    }
    return frames;
  }

  finish(): DesktopSseFrame[] {
    const frames: DesktopSseFrame[] = [];
    if (this.lineBuffer !== '') this.consumeLine(this.lineBuffer.replace(/\r$/, ''), frames);
    this.lineBuffer = '';
    this.dispatch(frames);
    return frames;
  }

  private consumeLine(line: string, frames: DesktopSseFrame[]): void {
    if (line === '') {
      this.dispatch(frames);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.eventChars += value.length + (this.dataLines.length > 0 ? 1 : 0);
    if (this.eventChars > MAX_SSE_EVENT_CHARS) {
      throw new DesktopSseProtocolError('SSE event exceeded the browser limit.');
    }
    this.dataLines.push(value);
  }

  private dispatch(frames: DesktopSseFrame[]): void {
    if (this.dataLines.length === 0) return;
    this.eventCount += 1;
    if (this.eventCount > MAX_SSE_EVENTS) {
      throw new DesktopSseProtocolError('SSE event count exceeded the browser limit.');
    }
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    this.eventChars = 0;
    if (data.trim() === '') return;
    frames.push(data.trim() === '[DONE]' ? { done: true } : { done: false, data });
  }
}

async function boundedErrorBody(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_STREAM_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function streamFailure(message: string, transportFailure = false): DesktopClientResult<never> {
  return {
    ok: false,
    error: { code: transportFailure ? 'connector_unavailable' : 'command_failed', message },
    ...(transportFailure ? { transportFailure: true as const } : {}),
  };
}

async function desktopChatStream(
  body: DesktopAiChatRequest,
  opts: DesktopAiChatStreamOptions,
  capabilityToken: string,
  providerId?: string
): Promise<DesktopClientResult<DesktopAiChatStreamSummary>> {
  const controller = new AbortController();
  let abortKind: 'external' | 'timeout' | null = null;
  const requestedTimeout = Number.isFinite(opts.timeoutMs) ? Math.trunc(opts.timeoutMs as number) : DEFAULT_STREAM_TIMEOUT_MS;
  const timeoutMs = Math.min(300_000, Math.max(1_000, requestedTimeout));
  const onExternalAbort = () => {
    if (abortKind !== null) return;
    abortKind = 'external';
    controller.abort();
  };
  if (opts.signal?.aborted) onExternalAbort();
  else opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    if (abortKind !== null) return;
    abortKind = 'timeout';
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${getDesktopBaseUrl()}${aiGatewayPath(providerId, 'chat/completions')}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...desktopAuthHeaders(),
        'X-FormLogic-Capability': capabilityToken,
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
  } catch {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    if (abortKind === 'external') return streamFailure('The AI stream was cancelled.');
    if (abortKind === 'timeout') return streamFailure('The AI stream timed out.', true);
    return streamFailure('FormLogic Desktop is not reachable.', true);
  }

  try {
    if (response.status === 401) {
      clearDesktopToken();
      const bodyValue = await boundedErrorBody(response);
      const error = asRecord(asRecord(bodyValue)?.error);
      return {
        ok: false,
        error: isErrorShape(error)
          ? error
          : { code: 'auth_required', message: 'Pairing with FormLogic Desktop is required.' },
      };
    }
    if (!response.ok) {
      const bodyValue = await boundedErrorBody(response);
      const error = asRecord(asRecord(bodyValue)?.error);
      if (isErrorShape(error)) return { ok: false, error };
      return streamFailure(`FormLogic Desktop responded ${response.status}.`);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('text/event-stream')) {
      return streamFailure('Desktop returned a non-streaming response to a streaming request.');
    }
    if (!response.body) return streamFailure('Desktop returned an empty AI stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = new DesktopSseParser();
    let bytes = 0;
    let chunks = 0;
    let sawDone = false;

    const deliver = async (frames: DesktopSseFrame[]) => {
      for (const frame of frames) {
        if (frame.done) {
          sawDone = true;
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data ?? '');
        } catch {
          throw new DesktopSseProtocolError('SSE data was not JSON.');
        }
        const chunk = asRecord(parsed);
        if (!chunk) throw new DesktopSseProtocolError('SSE data was not an object.');
        if (asRecord(chunk.error)) throw new DesktopSseUpstreamError('Upstream stream error.');
        try {
          await opts.onChunk(chunk as DesktopAiChatStreamChunk);
        } catch {
          throw new DesktopSseConsumerError('Stream consumer failed.');
        }
        chunks += 1;
      }
    };

    try {
      while (!sawDone) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_SSE_TOTAL_BYTES) {
          throw new DesktopSseProtocolError('SSE response exceeded the browser limit.');
        }
        await deliver(parser.push(decoder.decode(next.value, { stream: true })));
      }
      if (!sawDone) {
        const tail = decoder.decode();
        if (tail) await deliver(parser.push(tail));
        await deliver(parser.finish());
      }
      if (sawDone) await reader.cancel().catch(() => undefined);
      return { ok: true, data: { chunks, bytes, sawDone } };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (abortKind === 'external') return streamFailure('The AI stream was cancelled.');
      if (abortKind === 'timeout') return streamFailure('The AI stream timed out.', true);
      if (error instanceof DesktopSseConsumerError) {
        return streamFailure('The website could not process an AI stream chunk.');
      }
      if (error instanceof DesktopSseUpstreamError) {
        return streamFailure('The AI provider reported a streaming error.');
      }
      if (error instanceof DesktopSseProtocolError || error instanceof TypeError) {
        return streamFailure('Desktop returned an invalid or oversized AI event stream.');
      }
      return streamFailure('The AI stream ended unexpectedly.', true);
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

// ── Connector capabilities (audit SEC-001/C-08) ─────────────────────────────
// A LINKED desktop refuses browser connector commands without a server-minted,
// role-derived capability, so origin pairing alone no longer authorises the
// phone. Minted per (current app, connector), cached until shortly before
// expiry. Deliberately free of the full lib/api client (module-cycle safety): the
// mint endpoint only needs the configured backend base, session cookie, and CSRF
// token. The base may be absolute in a split-domain deployment.
let capabilityAppSlug: string | null = null;
let capabilityContextEpoch = 0;
const capabilityCache = new Map<string, { token: string; validUntil: number }>();
const serviceCapabilityCache = new Map<string, { token: string; validUntil: number }>();
const serviceCapabilityInFlight = new Map<string, Promise<string | null>>();

/** The app whose membership/role scopes capability mints (set by the app runtime). */
export function setConnectorCapabilityContext(appSlug: string | null): void {
  // Treat every context assignment as a new principal/session epoch, even if
  // the slug text is unchanged. This prevents a same-tab owner -> member login
  // from reusing the prior principal's short-lived token.
  capabilityContextEpoch += 1;
  capabilityAppSlug = appSlug;
  capabilityCache.clear();
  serviceCapabilityCache.clear();
  serviceCapabilityInFlight.clear();
}

export function invalidateConnectorCapability(connectorId: string): void {
  capabilityCache.delete(connectorId);
}

function invalidateServiceCapability(serviceId: string): void {
  serviceCapabilityCache.delete(serviceId);
}

function capabilityFailure<T>(serviceId: string): DesktopClientResult<T> {
  return {
    ok: false,
    error: {
      code: 'capability_denied',
      message: `The current app owner could not authorize the ${serviceId} Desktop service.`,
    },
  };
}

type DesktopServiceId = 'openai-api' | 'openai-codex-agent';

async function mintServiceCapability(
  serviceId: DesktopServiceId,
  contextEpoch: number,
  appSlug: string | null
): Promise<string | null> {
  try {
    const csrf = typeof document !== 'undefined'
      ? document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/)?.[1]
      : undefined;
    const mintPath = appSlug
      ? `/app/${encodeURIComponent(appSlug)}/service-capability`
      : '/service-capability';
    const res = await fetch(resolveBackendApiUrl(mintPath), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
      },
      body: JSON.stringify({ serviceId }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      token?: unknown;
      serviceId?: unknown;
      expiresInSeconds?: unknown;
    };
    if (
      data.serviceId !== serviceId ||
      typeof data.token !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(data.token)
    ) {
      return null;
    }
    const ttl = typeof data.expiresInSeconds === 'number' && Number.isFinite(data.expiresInSeconds)
      ? data.expiresInSeconds
      : 300;
    const ttlMs = Math.max(5, Math.min(270, ttl - 30)) * 1000;
    // A logout/login or app-context reassignment can race the cloud response.
    // Never cache or return authority minted for the previous principal epoch.
    if (capabilityContextEpoch !== contextEpoch || capabilityAppSlug !== appSlug) return null;
    serviceCapabilityCache.set(serviceId, { token: data.token, validUntil: Date.now() + ttlMs });
    return data.token;
  } catch {
    return null;
  }
}

async function getServiceCapability(serviceId: DesktopServiceId): Promise<string | null> {
  const cached = serviceCapabilityCache.get(serviceId);
  if (cached && cached.validUntil > Date.now()) return cached.token;

  const contextEpoch = capabilityContextEpoch;
  const appSlug = capabilityAppSlug;
  const inFlightKey = `${contextEpoch}:${serviceId}`;
  let pending = serviceCapabilityInFlight.get(inFlightKey);
  if (!pending) {
    pending = mintServiceCapability(serviceId, contextEpoch, appSlug);
    serviceCapabilityInFlight.set(inFlightKey, pending);
  }

  try {
    const token = await pending;
    if (capabilityContextEpoch !== contextEpoch || capabilityAppSlug !== appSlug) return null;
    return token;
  } finally {
    if (serviceCapabilityInFlight.get(inFlightKey) === pending) {
      serviceCapabilityInFlight.delete(inFlightKey);
    }
  }
}

async function withServiceCapability<T>(
  serviceId: DesktopServiceId,
  send: (token: string) => Promise<DesktopClientResult<T>>
): Promise<DesktopClientResult<T>> {
  const first = await getServiceCapability(serviceId);
  if (!first) return capabilityFailure(serviceId);
  let result = await send(first);
  if (!result.ok && result.error.code === 'capability_denied') {
    invalidateServiceCapability(serviceId);
    const fresh = await getServiceCapability(serviceId);
    if (fresh) result = await send(fresh);
  }
  return result;
}

async function getConnectorCapability(connectorId: string): Promise<string | null> {
  // Outside an app there is no role to derive from — a linked desktop will
  // (correctly) refuse; an unlinked desktop keeps its legacy local gating.
  if (!capabilityAppSlug) return null;
  const cached = capabilityCache.get(connectorId);
  if (cached && cached.validUntil > Date.now()) return cached.token;
  try {
    const csrf = typeof document !== 'undefined'
      ? document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/)?.[1]
      : undefined;
    const res = await fetch(resolveBackendApiUrl(`/app/${encodeURIComponent(capabilityAppSlug)}/connector-capability`), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
      },
      body: JSON.stringify({ connectorId }),
    });
    if (!res.ok) return null; // e.g. 403: role has no connector access — the desktop's denial is authoritative
    const data = (await res.json()) as { token?: string; expiresInSeconds?: number };
    if (typeof data.token !== 'string' || data.token === '') return null;
    // Refresh 30s early so an in-flight command never carries a just-expired token.
    const ttlMs = Math.max(5, Math.min(270, (data.expiresInSeconds ?? 300) - 30)) * 1000;
    capabilityCache.set(connectorId, { token: data.token, validUntil: Date.now() + ttlMs });
    return data.token;
  } catch {
    return null;
  }
}

export const desktopClient = {
  /** GET /api/desktop/info — name, versions, platform (origin-gated). */
  info(): Promise<DesktopClientResult<DesktopInstanceInfo>> {
    return desktopFetch<DesktopInstanceInfo>('/api/desktop/info');
  },

  plugins: {
    list(): Promise<DesktopClientResult<DesktopPluginSummary[]>> {
      return desktopFetch<unknown>('/api/plugins').then((r) => mapList<DesktopPluginSummary>(r, 'plugins'));
    },
    get(id: string): Promise<DesktopClientResult<DesktopPluginSummary>> {
      return desktopFetch<DesktopPluginSummary>(`/api/plugins/${encodeURIComponent(id)}`);
    },
    start(id: string): Promise<DesktopClientResult<unknown>> {
      return desktopFetch<unknown>(`/api/plugins/${encodeURIComponent(id)}/start`, { method: 'POST' });
    },
    stop(id: string): Promise<DesktopClientResult<unknown>> {
      return desktopFetch<unknown>(`/api/plugins/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    },
    logs(id: string, tail = 100): Promise<DesktopClientResult<string[]>> {
      return desktopFetch<unknown>(`/api/plugins/${encodeURIComponent(id)}/logs?tail=${tail}`).then((r) =>
        mapList<string>(r, 'logs')
      );
    },
  },

  services: {
    /** GET /api/services — local AI/tool services managed by Desktop ({services:[...], dataDir}). */
    list(): Promise<DesktopClientResult<DesktopServiceSnapshot[]>> {
      return desktopFetch<unknown>('/api/services').then((r) => mapList<DesktopServiceSnapshot>(r, 'services'));
    },
  },

  servicePlatform: {
    /** Safe ServiceDefinition projection; credentials/auth transports are omitted. */
    catalog(): Promise<DesktopClientResult<DesktopServiceCatalog>> {
      return desktopFetch<unknown>('/api/services/catalog').then(mapServiceCatalog);
    },

    codex: {
      /** Owner-only website access; capability mint/refresh stays internal. */
      status(): Promise<DesktopClientResult<DesktopCodexStatus>> {
        return withServiceCapability('openai-codex-agent', (capabilityToken) =>
          desktopFetch<DesktopCodexStatus>('/api/services/codex/status', {
            headers: { 'X-FormLogic-Capability': capabilityToken },
          })
        );
      },

      models(): Promise<DesktopClientResult<DesktopCodexModel[]>> {
        return withServiceCapability<unknown>('openai-codex-agent', (capabilityToken) =>
          desktopFetch<unknown>('/api/services/codex/models', {
            signal: timeoutSignal(35_000),
            headers: { 'X-FormLogic-Capability': capabilityToken },
          })
        ).then((res) => mapList<DesktopCodexModel>(res, 'models'));
      },

      assistantChat(
        body: DesktopCodexChatRequest,
        opts: { signal?: AbortSignal } = {}
      ): Promise<DesktopClientResult<DesktopCodexChatResponse>> {
        return withServiceCapability('openai-codex-agent', (capabilityToken) =>
          desktopFetch<DesktopCodexChatResponse>('/api/services/codex/actions/assistant.chat', {
            method: 'POST',
            body: JSON.stringify(body),
            signal: opts.signal ?? timeoutSignal(15 * 60 * 1000),
            headers: { 'X-FormLogic-Capability': capabilityToken },
          })
        );
      },
    },
  },

  ai: {
    /** GET /api/ai/sources — union of service instances + AI providers ({sources:[...]}, SRC-202). */
    sources(): Promise<DesktopClientResult<DesktopAiSource[]>> {
      return desktopFetch<unknown>('/api/ai/sources').then((r) => mapList<DesktopAiSource>(r, 'sources'));
    },

    /**
     * POST an OpenAI-compatible chat request through Desktop. The browser sends
     * only its pairing token; Desktop attaches the selected provider credential
     * server-side, so a website flow never receives or transmits that secret.
     */
    async chat(
      body: DesktopAiChatRequest,
      providerId?: string,
      opts?: { signal?: AbortSignal }
    ): Promise<DesktopClientResult<Record<string, unknown>>> {
      const path = aiGatewayPath(providerId, 'chat/completions');
      return withServiceCapability(aiCapabilityService(providerId), (capabilityToken) =>
        desktopFetch<Record<string, unknown>>(path, {
          method: 'POST',
          body: JSON.stringify(body),
          ...(opts?.signal ? { signal: opts.signal } : {}),
          headers: { 'X-FormLogic-Capability': capabilityToken },
        })
      );
    },

    /** List models through the same authenticated, credential-hiding gateway. */
    async models(providerId?: string): Promise<DesktopClientResult<DesktopAiModel[]>> {
      const path = aiGatewayPath(providerId, 'models');
      const result = await withServiceCapability<unknown>(aiCapabilityService(providerId), (capabilityToken) =>
        desktopFetch<unknown>(path, {
          headers: { 'X-FormLogic-Capability': capabilityToken },
        })
      );
      return mapList<DesktopAiModel>(result, 'data');
    },

    /**
     * Stream the generic Desktop chat gateway. SSE framing, UTF-8, event size,
     * total bytes, event count and total time are bounded before callbacks run.
     */
    chatStream(
      body: DesktopAiChatRequest,
      opts: DesktopAiChatStreamOptions,
      providerId?: string
    ): Promise<DesktopClientResult<DesktopAiChatStreamSummary>> {
      return withServiceCapability(aiCapabilityService(providerId), (capabilityToken) =>
        desktopChatStream(body, opts, capabilityToken, providerId)
      );
    },

    /** Multipart speech-to-text through a default or explicitly pinned provider. */
    async transcribe(
      body: DesktopAiTranscriptionRequest,
      providerId?: string,
      opts?: { signal?: AbortSignal }
    ): Promise<DesktopClientResult<DesktopAiTranscriptionResponse>> {
      const result = await withServiceCapability<unknown>('openai-api', (capabilityToken) =>
        desktopFetch<unknown>(aiGatewayPath(providerId, 'audio/transcriptions'), {
          method: 'POST',
          body: transcriptionFormData(body),
          signal: opts?.signal ?? timeoutSignal(125_000),
          headers: { 'X-FormLogic-Capability': capabilityToken },
        })
      );
      return mapRequiredStringObject<DesktopAiTranscriptionResponse>(
        result,
        'text',
        'Desktop returned an invalid transcription response.'
      );
    },

    /** Typed audio-capable Chat Completions request through Desktop-held credentials. */
    async audioChat(
      body: DesktopAiAudioChatRequest,
      providerId?: string,
      opts?: { signal?: AbortSignal }
    ): Promise<DesktopClientResult<DesktopAiAudioChatResponse>> {
      return withServiceCapability('openai-api', (capabilityToken) =>
        desktopFetch<DesktopAiAudioChatResponse>(aiGatewayPath(providerId, 'audio/chat/completions'), {
          method: 'POST',
          body: JSON.stringify(body),
          signal: opts?.signal ?? timeoutSignal(125_000),
          headers: { 'X-FormLogic-Capability': capabilityToken },
        })
      );
    },

    /** Exchange a WebRTC offer for an SDP answer without exposing the provider key. */
    async createRealtimeSession(
      body: DesktopAiRealtimeSessionRequest,
      providerId?: string,
      opts?: { signal?: AbortSignal }
    ): Promise<DesktopClientResult<DesktopAiRealtimeSessionResponse>> {
      const result = await withServiceCapability<unknown>('openai-api', (capabilityToken) =>
        desktopFetch<unknown>(aiGatewayPath(providerId, 'realtime/sessions'), {
          method: 'POST',
          body: JSON.stringify(body),
          signal: opts?.signal ?? timeoutSignal(35_000),
          headers: { 'X-FormLogic-Capability': capabilityToken },
        })
      );
      return mapRequiredStringObject<DesktopAiRealtimeSessionResponse>(
        result,
        'sdp',
        'Desktop returned an invalid Realtime SDP response.'
      );
    },
  },

  connectors: {
    list(): Promise<DesktopClientResult<DesktopConnectorSummary[]>> {
      return desktopFetch<unknown>('/api/connectors').then((r) => mapList<DesktopConnectorSummary>(r, 'connectors'));
    },
    status(connectorId: string): Promise<DesktopClientResult<DesktopConnectorStatus>> {
      return desktopFetch<DesktopConnectorStatus>(`/api/connectors/${encodeURIComponent(connectorId)}/status`);
    },
    /**
     * POST /api/connectors/{id}/request — THE gateway FormLogic Web uses. Body/response
     * per connector-request/response.schema.json. Resolves the command's `data` payload
     * on success; the typed error envelope otherwise (never throws).
     *
     * SEC-001: every request carries the member's short-lived, role-derived connector
     * capability (minted server-side for the CURRENT app); a linked desktop refuses
     * commands without one. A capability_denied on a cached token invalidates it and
     * retries ONCE with a fresh mint (role may have just changed).
     */
    async request(
      connectorId: string,
      command: string,
      payload?: unknown,
      opts?: { timeoutMs?: number; requestId?: string }
    ): Promise<DesktopClientResult<unknown>> {
      const body: DesktopConnectorRequestBody = { connectorId, command };
      if (payload !== undefined) body.payload = payload;
      if (opts?.timeoutMs !== undefined) body.timeoutMs = opts.timeoutMs;
      if (opts?.requestId !== undefined) body.requestId = opts.requestId;
      const send = async (capability: string | null) =>
        desktopFetch<{ ok: true; data?: unknown; requestId?: string }>(
          `/api/connectors/${encodeURIComponent(connectorId)}/request`,
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: capability ? { 'X-FormLogic-Capability': capability } : undefined,
          }
        );
      let res = await send(await getConnectorCapability(connectorId));
      if (!res.ok && res.error.code === 'capability_denied') {
        invalidateConnectorCapability(connectorId);
        const fresh = await getConnectorCapability(connectorId);
        if (fresh) res = await send(fresh);
      }
      if (!res.ok) return res;
      // Unwrap the connector-response success envelope to the command's data payload.
      return { ok: true, data: res.data?.data, requestId: res.data?.requestId };
    },
  },

  origins: {
    list(): Promise<DesktopClientResult<DesktopTrustedOrigin[]>> {
      return desktopFetch<unknown>('/api/origins').then((r) => mapList<DesktopTrustedOrigin>(r, 'origins'));
    },
    revoke(origin: string): Promise<DesktopClientResult<unknown>> {
      return desktopFetch<unknown>(`/api/origins/${encodeURIComponent(origin)}`, { method: 'DELETE' });
    },
  },
};
