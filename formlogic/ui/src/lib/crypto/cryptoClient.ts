// Main-thread façade for the E2EE crypto worker (docs/E2EE_PRIVATE_FORMS_PLAN.md §10).
//
// Request/response over a dedicated module Worker (mirroring the formlogic.worker.ts
// pattern). The worker is created LAZILY on the first crypto call — so pages that
// never touch a private form never pay for it — and TERMINATED on lock; the next op
// spawns a fresh worker with a pristine heap. All long-lived secrets live inside the
// worker; this client holds none.
//
// The worker factory is injectable so vitest (node — no Worker) can drive the same
// protocol against an in-process adapter (see createInlineWorker below).

import type { InnerPayload, ResponseEnvelope } from './envelope';
import { currentSessionGeneration } from '../sessionGeneration';
import type {
  CryptoOp,
  CryptoWorkerRequest,
  CryptoWorkerResponse,
} from './worker';
import type {
  EnableEncryptionPayload,
  FormKeyGrantWire,
  IngestionKeyWire,
  ManifestRowWire,
  VaultWire,
} from '../../types/e2ee';

/** Minimal subset of the Worker interface the client needs (injectable for tests). */
export interface CryptoWorkerLike {
  postMessage(message: CryptoWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<CryptoWorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<CryptoWorkerResponse>) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

export type CryptoWorkerFactory = () => CryptoWorkerLike;

/**
 * In-process adapter used by tests: drives worker.ts's exported handler directly,
 * with terminate() mapped to a full state reset (what a real terminate achieves).
 */
export function createInlineWorker(): CryptoWorkerLike {
  // Dynamic-import free: worker.ts has no worker-only top-level side effects beyond
  // the guarded onmessage binding.
  let terminated = false;
  const listeners = new Set<(e: MessageEvent<CryptoWorkerResponse>) => void>();
  return {
    postMessage(message) {
      if (terminated) return;
      void import('./worker').then((mod) => mod.handleCryptoRequest(message)).then((response) => {
        if (terminated) return;
        for (const l of listeners) l({ data: response } as MessageEvent<CryptoWorkerResponse>);
      });
    },
    addEventListener: ((type: string, listener: unknown) => {
      if (type === 'message' && typeof listener === 'function') {
        listeners.add(listener as (e: MessageEvent<CryptoWorkerResponse>) => void);
      }
    }) as CryptoWorkerLike['addEventListener'],
    removeEventListener: ((type: string, listener: unknown) => {
      if (type === 'message' && typeof listener === 'function') {
        listeners.delete(listener as (e: MessageEvent<CryptoWorkerResponse>) => void);
      }
    }) as CryptoWorkerLike['removeEventListener'],
    terminate() {
      terminated = true;
      listeners.clear();
      void import('./worker').then((mod) => mod.__resetCryptoWorkerState());
    },
  };
}

export class CryptoClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CryptoClientError';
  }
}

function defaultFactory(): CryptoWorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

export class CryptoClient {
  /** Max wait for the graceful worker 'lock' op before a hard terminate (§10). */
  static readonly LOCK_OP_TIMEOUT_MS = 250;

  private factory: CryptoWorkerFactory;
  private worker: CryptoWorkerLike | null = null;
  private workerSessionGen: number | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listener: ((event: MessageEvent<CryptoWorkerResponse>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private messageErrorListener: ((event: MessageEvent) => void) | null = null;

  constructor(factory: CryptoWorkerFactory = defaultFactory) {
    this.factory = factory;
  }

  /** Whether a live worker exists (false before first use and after lock/terminate). */
  get isRunning(): boolean {
    return this.worker !== null;
  }

  private detachAndFailWorker(worker: CryptoWorkerLike, code: string, message: string): void {
    if (this.worker !== worker) return;
    const listener = this.listener;
    const errorListener = this.errorListener;
    const messageErrorListener = this.messageErrorListener;
    const oldPending = new Map(this.pending);
    this.worker = null;
    this.workerSessionGen = null;
    this.listener = null;
    this.errorListener = null;
    this.messageErrorListener = null;
    this.pending.clear();
    if (listener) worker.removeEventListener('message', listener);
    if (errorListener) worker.removeEventListener('error', errorListener);
    if (messageErrorListener) worker.removeEventListener('messageerror', messageErrorListener);
    try {
      worker.terminate();
    } catch {
      // Ignore termination errors on an already-failed worker.
    }
    for (const slot of oldPending.values()) {
      slot.reject(new CryptoClientError(code, message));
    }
  }

  private ensureWorker(): CryptoWorkerLike {
    if (!this.worker) {
      const worker = this.factory();
      this.listener = (event) => {
        const response = event.data;
        const slot = this.pending.get(response.id);
        if (!slot) return;
        this.pending.delete(response.id);
        if (response.ok) slot.resolve(response.result);
        else slot.reject(new CryptoClientError(response.error?.code ?? 'crypto_error', response.error?.message ?? 'Crypto operation failed'));
      };
      this.errorListener = (event) => {
        const msg = event?.message ? `Crypto worker failed: ${event.message}` : 'Crypto worker failed to start or crashed';
        this.detachAndFailWorker(worker, 'worker_error', msg);
      };
      this.messageErrorListener = () => {
        this.detachAndFailWorker(worker, 'worker_message_error', 'Crypto worker message could not be deserialized');
      };
      worker.addEventListener('message', this.listener);
      worker.addEventListener('error', this.errorListener);
      worker.addEventListener('messageerror', this.messageErrorListener);
      this.worker = worker;
      this.workerSessionGen = currentSessionGeneration();
    }
    return this.worker;
  }

  private call<T>(op: CryptoOp, payload?: unknown): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        worker.postMessage({ id, op, payload });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Lock the worker and TERMINATE it — the next op spawns a fresh one (plan §10).
   *  Bounded (review 2026-07-22): the graceful 'lock' op gets at most
   *  LOCK_OP_TIMEOUT_MS to zero secrets; a busy/wedged worker is hard-terminated
   *  after that either way, so this never waits indefinitely. */
  async lockAndTerminate(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    const listener = this.listener;
    const errorListener = this.errorListener;
    const messageErrorListener = this.messageErrorListener;
    const oldPending = new Map(this.pending);
    // Detach immediately so any subsequent unlock/call spawns a fresh isolated worker
    // and can never collide with or be killed by this dying worker's teardown.
    this.worker = null;
    this.workerSessionGen = null;
    this.listener = null;
    this.errorListener = null;
    this.messageErrorListener = null;
    this.pending.clear();
    if (errorListener) worker.removeEventListener('error', errorListener);
    if (messageErrorListener) worker.removeEventListener('messageerror', messageErrorListener);
    for (const slot of oldPending.values()) {
      slot.reject(new CryptoClientError('vault_locked', 'The vault was locked'));
    }
    const lockId = ++this.nextId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          const onLockReply = (event: MessageEvent<{ id?: number }>) => {
            if (event.data?.id === lockId) {
              worker.removeEventListener('message', onLockReply);
              resolve();
            }
          };
          worker.addEventListener('message', onLockReply);
          try {
            worker.postMessage({ id: lockId, op: 'lock', payload: {} });
          } catch {
            worker.removeEventListener('message', onLockReply);
            resolve();
          }
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CryptoClient.LOCK_OP_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Terminate regardless.
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (listener) worker.removeEventListener('message', listener);
      worker.terminate();
    }
  }

  /** Hard terminate without a lock round-trip (logout / tab-lock propagation path). */
  terminate(): void {
    const worker = this.worker;
    if (!worker) return;
    if (this.listener) worker.removeEventListener('message', this.listener);
    if (this.errorListener) worker.removeEventListener('error', this.errorListener);
    if (this.messageErrorListener) worker.removeEventListener('messageerror', this.messageErrorListener);
    worker.terminate();
    this.worker = null;
    this.workerSessionGen = null;
    this.listener = null;
    this.errorListener = null;
    this.messageErrorListener = null;
    for (const slot of this.pending.values()) {
      slot.reject(new CryptoClientError('vault_locked', 'The vault was locked'));
    }
    this.pending.clear();
  }

  /** Terminate only if the currently running worker was spawned in `sessionGen` (never kill a newer session's worker). */
  terminateForSession(sessionGen: number): void {
    if (this.worker !== null && this.workerSessionGen === sessionGen) {
      this.terminate();
    }
  }

  /** Gracefully lock and terminate only if the current worker belongs to `sessionGen`. */
  async lockAndTerminateForSession(sessionGen: number): Promise<void> {
    if (this.worker !== null && this.workerSessionGen === sessionGen) {
      await this.lockAndTerminate();
    }
  }

  // --- Vault ops ---

  status(): Promise<{ unlocked: boolean; userId: string | null }> {
    return this.call('status');
  }

  createVault(userId: string, passphrase: string): Promise<{ vault: VaultWire; recoveryDisplay: string }> {
    return this.call('createVault', { userId, passphrase });
  }

  unlock(userId: string, passphrase: string, vault: VaultWire): Promise<{ ok: true }> {
    return this.call('unlock', { userId, passphrase, vault });
  }

  recoveryUnlock(userId: string, recoveryCode: string, newPassphrase: string, vault: VaultWire): Promise<{
    rewrap: Pick<VaultWire, 'kdf' | 'kdfSalt' | 'kdfMemlimit' | 'kdfOpslimit' | 'wrappedUmk'>;
  }> {
    return this.call('recoveryUnlock', { userId, recoveryCode, newPassphrase, vault });
  }

  changePassphrase(userId: string, currentPassphrase: string, newPassphrase: string, vault: VaultWire): Promise<{
    rewrap: Pick<VaultWire, 'kdf' | 'kdfSalt' | 'kdfMemlimit' | 'kdfOpslimit' | 'wrappedUmk'>;
  }> {
    return this.call('changePassphrase', { userId, currentPassphrase, newPassphrase, vault });
  }

  // --- Form encryption ops ---

  enableFormEncryption(userId: string, formId: string, schemaJson: string): Promise<EnableEncryptionPayload> {
    return this.call('enableFormEncryption', { userId, formId, schemaJson });
  }

  publishSchemaVersion(
    userId: string,
    formId: string,
    args: { keyId: string; ingestEpoch: number; schemaJson: string; version: number },
  ): Promise<{ manifest: EnableEncryptionPayload['manifest']; schemaHash: string }> {
    return this.call('publishSchemaVersion', { userId, formId, ...args });
  }

  loadFormKeys(
    formId: string,
    grants: FormKeyGrantWire[],
    ingestionKeys: IngestionKeyWire[],
    manifests: ManifestRowWire[],
    schemaVersions: { version: number; schemaHash: string; schemaJson: string }[],
  ): Promise<{ loadedEpochs: number[] }> {
    return this.call('loadFormKeys', { formId, grants, ingestionKeys, manifests, schemaVersions });
  }

  sealResponse(args: {
    formId: string;
    keyId: string;
    epoch: number;
    schemaVersion: number;
    schemaHash: string;
    publicKey: string;
    rev?: number;
    recordId?: string;
    inner: InnerPayload;
  }): Promise<{ envelope: ResponseEnvelope }> {
    return this.call('sealResponse', args);
  }

  /**
   * Sign a data-node structure (flplacement:1 / flnodecert:1 only — the worker
   * enforces the domain allowlist) with the vault Ed25519 key
   * (docs/FORMLOGIC_DATA_NODES.md §11).
   */
  signDataStructure(
    domain: string,
    structure: Record<string, unknown>,
  ): Promise<{ signature: string; signerKeyId: string; signerFingerprint: string }> {
    return this.call('signDataStructure', { domain, structure });
  }

  openResponses(
    formId: string,
    items: { envelope: unknown }[],
    manifests: Pick<ManifestRowWire, 'keyId' | 'ingestEpoch' | 'schemaVersion' | 'schemaHash'>[],
    keys: Pick<IngestionKeyWire, 'id' | 'state' | 'acceptUntil'>[],
  ): Promise<{
    results: ({ recordId: string; rev: number; inner: InnerPayload } | { recordId: string; error: { code: string; message: string } })[];
  }> {
    return this.call('openResponses', { formId, items, manifests, keys });
  }
}

// ---------------------------------------------------------------------------
// Singleton — the app shares ONE crypto worker; vaultStore drives its lifecycle.
// ---------------------------------------------------------------------------

let singleton: CryptoClient | null = null;

export function getCryptoClient(): CryptoClient {
  if (!singleton) singleton = new CryptoClient();
  return singleton;
}

/** Test hook: swap the singleton for one backed by an inline worker. */
export function setCryptoClientForTests(client: CryptoClient | null): void {
  singleton = client;
}
