// FormLogic Desktop event hub (docs/FORMLOGIC_DESKTOP.md §2 SSE + §7 dedupe).
//
// Subscribes to GET /api/events?token=... and fans validated desktop-event envelopes out
// to in-page listeners (the flows dispatcher, app-logic onConnectorEvent wiring, SDK
// screens, the owner panel). One hub per page — every consumer sees the same stream.
//
// Transport: the contract's SSE stream sets `event: <envelope name>` per message, and the
// DOM EventSource API cannot wildcard NAMED events (addEventListener needs each exact
// name up front, and plugin event names are open-ended). So the hub speaks SSE over a
// streaming fetch — same wire format, same `?token=` auth (contract §2 allows the query
// param for event streams) — and parses `id:`/`event:`/`data:`/`: ping` frames itself.
//
// Reliability rules (contract §7): consumers MUST dedupe on idempotencyKey — the hub does
// this centrally with an LRU of the last 512 keys, so duplicates under desktop
// crash/retry never reach listeners twice. Envelopes failing minimal validation are
// dropped, never dispatched. Reconnects use exponential backoff (1s → 30s).
//
// The connection is demand-driven: it exists only while (a) someone is subscribed AND
// (b) Desktop is detected AND (c) a pairing token is held. The mock aokie connector's
// simulator injects envelopes locally through the SAME validate+dedupe pipeline
// (emitLocalDesktopEvent), so demos/tests work with no Desktop at all.
import { logger } from '../../lib/logger';
import { getDesktopBaseUrl, type DesktopEventEnvelope } from './desktopTypes';
import { getDesktopToken } from './desktopPairing';
import { getDesktopInfo, subscribeDesktopStatus } from './desktopDetection';

const DEDUPE_LRU_SIZE = 512;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type DesktopEventListener = (event: DesktopEventEnvelope) => void;

const listeners = new Set<DesktopEventListener>();

// Insertion-ordered Set as the LRU: re-seen keys are refreshed, oldest evicted at cap.
const seenKeys = new Set<string>();

let abortController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let unsubscribeDetection: (() => void) | null = null;
let connectedToken: string | null = null;

/** Minimal envelope validation: the schema's required fields, correctly typed. */
export function isValidDesktopEvent(value: unknown): value is DesktopEventEnvelope {
  const v = value as Partial<DesktopEventEnvelope> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    v.schemaVersion === 1 &&
    typeof v.source === 'string' && v.source.length > 0 &&
    typeof v.name === 'string' && v.name.length > 0 &&
    typeof v.correlationId === 'string' && v.correlationId.length > 0 &&
    typeof v.idempotencyKey === 'string' && v.idempotencyKey.length > 0 &&
    typeof v.occurredAt === 'string' &&
    'data' in v
  );
}

/** True when this key was already dispatched (and refresh its LRU position). */
function isDuplicate(idempotencyKey: string): boolean {
  if (seenKeys.has(idempotencyKey)) {
    // Refresh recency so a hot key isn't evicted while still active.
    seenKeys.delete(idempotencyKey);
    seenKeys.add(idempotencyKey);
    return true;
  }
  seenKeys.add(idempotencyKey);
  if (seenKeys.size > DEDUPE_LRU_SIZE) {
    const oldest = seenKeys.values().next().value as string | undefined;
    if (oldest !== undefined) seenKeys.delete(oldest);
  }
  return false;
}

/**
 * The single ingestion point: validate → dedupe → fan out. Used by the SSE stream AND by
 * local producers (the mock aokie simulator). Returns true when the event was dispatched.
 */
export function ingestDesktopEvent(raw: unknown): boolean {
  if (!isValidDesktopEvent(raw)) return false;
  if (isDuplicate(raw.idempotencyKey)) return false;
  for (const listener of listeners) {
    try {
      listener(raw);
    } catch (e) {
      logger.warn('[desktop-events] listener threw:', e);
    }
  }
  return true;
}

/**
 * Inject a locally-produced envelope (mock connectors, tests) through the same
 * validate+dedupe pipeline as the live stream. Clearly a local aid — a real Desktop
 * delivers events over SSE only.
 */
export function emitLocalDesktopEvent(envelope: DesktopEventEnvelope): boolean {
  return ingestDesktopEvent(envelope);
}

// ---------------------------------------------------------------------------
// SSE transport (streaming fetch).
// ---------------------------------------------------------------------------

/** Parse one SSE frame's accumulated `data:` lines into an envelope and ingest it. */
function handleSseData(data: string): void {
  if (!data) return;
  try {
    ingestDesktopEvent(JSON.parse(data));
  } catch {
    /* malformed data frame — dropped per the validation rule */
  }
}

async function readSseStream(res: Response, signal: AbortSignal): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No stream body');
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) return;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        // Frame boundary → dispatch. (`event:`/`id:` fields are informational —
        // the full envelope, including name + idempotencyKey, is in the data JSON.)
        handleSseData(dataLines.join('\n'));
        dataLines = [];
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      // `id:`, `event:`, `: ping` keep-alives — nothing to do.
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null || listeners.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectIfReady();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function disconnect(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  connectedToken = null;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function connectIfReady(): void {
  if (listeners.size === 0) return;
  const token = getDesktopToken();
  if (!getDesktopInfo().available || !token) return; // detection subscription retries us on change
  if (abortController && connectedToken === token) return; // already connected with this token

  disconnect();
  const controller = new AbortController();
  abortController = controller;
  connectedToken = token;

  // Fetch-based SSE can set headers, so the pairing token travels as a
  // Bearer header like every other desktop call — never in the URL, where
  // it would land in server/proxy logs (audit FL-008).
  const url = `${getDesktopBaseUrl()}/api/events`;
  void fetch(url, {
    credentials: 'omit',
    cache: 'no-store',
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`events stream responded ${res.status}`);
      reconnectDelay = RECONNECT_MIN_MS; // a healthy connection resets the backoff
      await readSseStream(res, controller.signal);
      throw new Error('events stream ended');
    })
    .catch(() => {
      if (controller.signal.aborted) return; // deliberate disconnect — no reconnect
      if (abortController === controller) {
        abortController = null;
        connectedToken = null;
      }
      scheduleReconnect();
    });
}

/**
 * Subscribe to desktop events. The first subscriber wires up desktop detection (which
 * itself only polls while subscribed) and opens the SSE stream once Desktop is detected
 * AND paired; the last unsubscribe tears everything down. Locally-emitted (mock) events
 * flow regardless of any Desktop being present.
 */
export function subscribeDesktopEvents(listener: DesktopEventListener): () => void {
  listeners.add(listener);
  if (!unsubscribeDetection) {
    unsubscribeDetection = subscribeDesktopStatus(() => connectIfReady());
  }
  connectIfReady();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      disconnect();
      unsubscribeDetection?.();
      unsubscribeDetection = null;
    }
  };
}

/** Number of live hub listeners (diagnostics). */
export function desktopEventListenerCount(): number {
  return listeners.size;
}

/** Reset hub state — listeners, dedupe LRU, connection. Test-only. */
export function __resetDesktopEventsForTests(): void {
  disconnect();
  unsubscribeDetection?.();
  unsubscribeDetection = null;
  listeners.clear();
  seenKeys.clear();
  reconnectDelay = RECONNECT_MIN_MS;
}
