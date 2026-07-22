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
  removeEventListener(type: 'message', listener: (event: MessageEvent<CryptoWorkerResponse>) => void): void;
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
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
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
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listener: ((event: MessageEvent<CryptoWorkerResponse>) => void) | null = null;

  constructor(factory: CryptoWorkerFactory = defaultFactory) {
    this.factory = factory;
  }

  /** Whether a live worker exists (false before first use and after lock/terminate). */
  get isRunning(): boolean {
    return this.worker !== null;
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
      worker.addEventListener('message', this.listener);
      this.worker = worker;
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
    try {
      await Promise.race([
        this.call('lock').then(
          () => undefined,
          () => undefined, // lock must succeed even if the op fails — terminate regardless
        ),
        new Promise<void>((resolve) => {
          setTimeout(resolve, CryptoClient.LOCK_OP_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Terminate regardless.
    }
    if (this.listener) worker.removeEventListener('message', this.listener);
    worker.terminate();
    this.worker = null;
    this.listener = null;
    for (const slot of this.pending.values()) {
      slot.reject(new CryptoClientError('vault_locked', 'The vault was locked'));
    }
    this.pending.clear();
  }

  /** Hard terminate without a lock round-trip (logout / tab-lock propagation path). */
  terminate(): void {
    const worker = this.worker;
    if (!worker) return;
    if (this.listener) worker.removeEventListener('message', this.listener);
    worker.terminate();
    this.worker = null;
    this.listener = null;
    for (const slot of this.pending.values()) {
      slot.reject(new CryptoClientError('vault_locked', 'The vault was locked'));
    }
    this.pending.clear();
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
