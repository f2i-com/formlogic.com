// Per-browser local storage for the shared public "Demo" account. Anything a visitor "submits" while
// exploring the demo is kept HERE (IndexedDB), never sent to the server — so the shared demo can't be
// polluted with abusive/junk data and every visitor gets a clean, seeded starting point plus their own
// private additions. Reads merge the server-seeded records with these local ones.

export type DemoRecord = {
  id: string;
  answers: Record<string, unknown>;
  submittedAt: string;
  status: string;
  _local: true;
};

const DB_NAME = 'formlogic-demo';
const STORE = 'records'; // key: formId → DemoRecord[]
const FLOWS_STORE = 'flows'; // fixed keys: 'created' | 'edits' | 'deleted' (see the flows overlay below)
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
      if (!req.result.objectStoreNames.contains(FLOWS_STORE)) {
        req.result.createObjectStore(FLOWS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function read(formId: string): Promise<DemoRecord[]> {
  try {
    const db = await openDb();
    return await new Promise<DemoRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(formId);
      rq.onsuccess = () => resolve(Array.isArray(rq.result) ? rq.result : []);
      rq.onerror = () => reject(rq.error);
    });
  } catch {
    return [];
  }
}

async function write(formId: string, records: DemoRecord[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(records, formId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort — a private demo write that can't persist just isn't kept */
  }
}

// Generic read/write for the flows overlay store.
async function readFlowsKey<T>(key: string, fallback: T): Promise<T> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(FLOWS_STORE, 'readonly');
      const rq = tx.objectStore(FLOWS_STORE).get(key);
      rq.onsuccess = () => resolve(rq.result === undefined ? fallback : (rq.result as T));
      rq.onerror = () => reject(rq.error);
    });
  } catch {
    return fallback;
  }
}

async function writeFlowsKey(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FLOWS_STORE, 'readwrite');
      tx.objectStore(FLOWS_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort */
  }
}

function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'x' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
}

/** True for ids minted locally by the demo overlay (vs. server-seeded records). */
export function isDemoLocalId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('demolocal_');
}

/** Wipe every locally-stored demo record (all forms). Used when the shared demo dataset is
 *  regenerated — local records referencing the replaced data would dangle forever. */
export async function clearDemoRecords(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, FLOWS_STORE], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(FLOWS_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort */
  }
}

/** Store a new demo submission locally and return the synthetic record. */
export async function addDemoRecord(formId: string, answers: Record<string, unknown>): Promise<DemoRecord> {
  const rec: DemoRecord = {
    id: 'demolocal_' + uuid(),
    answers,
    submittedAt: new Date().toISOString(),
    status: 'submitted',
    _local: true,
  };
  const arr = await read(formId);
  arr.push(rec);
  await write(formId, arr);
  return rec;
}

/** Local demo records for a form, newest first. */
export async function getDemoRecords(formId: string): Promise<DemoRecord[]> {
  const arr = await read(formId);
  return arr.slice().reverse();
}

export async function getDemoRecord(formId: string, id: string): Promise<DemoRecord | null> {
  const arr = await read(formId);
  return arr.find((r) => r.id === id) ?? null;
}

export async function updateDemoRecord(formId: string, id: string, answers: Record<string, unknown>): Promise<DemoRecord | null> {
  const arr = await read(formId);
  const i = arr.findIndex((r) => r.id === id);
  if (i === -1) return null;
  arr[i] = { ...arr[i], answers };
  await write(formId, arr);
  return arr[i];
}

export async function deleteDemoRecord(formId: string, id: string): Promise<void> {
  const arr = await read(formId);
  await write(formId, arr.filter((r) => r.id !== id));
}

// ── Flows overlay ──────────────────────────────────────────────────────────────
// FormLogic Flows are editable in the shared demo the same way records are: a visitor's
// creates/edits/deletes live HERE (IndexedDB), never on the server. Reads merge the
// server-seeded flow definitions with this overlay. Three keys in FLOWS_STORE:
//   'created' → DemoFlow[]                (new flows this visitor authored)
//   'edits'   → Record<flowId, Partial>   (field overrides for seeded flows)
//   'deleted' → string[]                  (ids of seeded flows this visitor removed)
import type { FlowDefinition } from '../types/flows';

type DemoFlow = FlowDefinition & { _local: true };
type FlowEdits = Record<string, Partial<FlowDefinition>>;

/** Input shape shared by create/duplicate (mirrors the api.createWorkspaceFlow/createFlow body). */
export interface DemoFlowInput {
  appId: string | null;
  name: string;
  slug: string;
  description?: string | null;
  flowJson: FlowDefinition['flowJson'];
  enabled?: boolean;
  nodeCapabilities?: string[] | null;
}

/** Pure overlay merge (no IndexedDB) — exported for tests. Local creates first (newest), then the
 *  seeded flows with deletes removed and edits applied. */
export function mergeFlowOverlay(
  appId: string | null,
  serverFlows: FlowDefinition[],
  overlay: { created: FlowDefinition[]; edits: FlowEdits; deleted: string[] },
): FlowDefinition[] {
  const deletedSet = new Set(overlay.deleted);
  const merged = serverFlows
    .filter((f) => !deletedSet.has(f.id))
    .map((f) => (overlay.edits[f.id] ? { ...f, ...overlay.edits[f.id] } : f));
  const localForScope = overlay.created.filter((f) => (f.appId ?? null) === (appId ?? null) && !deletedSet.has(f.id));
  return [...localForScope, ...merged];
}

/** Merge the server-seeded flows for one scope (appId, or null for workspace) with the overlay. */
export async function demoApplyFlowOverlay(appId: string | null, serverFlows: FlowDefinition[]): Promise<FlowDefinition[]> {
  const [edits, deleted, created] = await Promise.all([
    readFlowsKey<FlowEdits>('edits', {}),
    readFlowsKey<string[]>('deleted', []),
    readFlowsKey<DemoFlow[]>('created', []),
  ]);
  return mergeFlowOverlay(appId, serverFlows, { created, edits, deleted });
}

/** Persist a new flow locally and return the synthetic definition. */
export async function demoCreateFlow(input: DemoFlowInput): Promise<FlowDefinition> {
  const now = new Date().toISOString();
  const flow: DemoFlow = {
    id: 'demolocal_' + uuid(),
    ownerUserId: 'demo',
    appId: input.appId ?? null,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    engine: 'f2i',
    flowJson: input.flowJson,
    inputSchema: null,
    outputSchema: null,
    nodeCapabilities: input.nodeCapabilities ?? null,
    version: 1,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    _local: true,
  };
  const created = await readFlowsKey<DemoFlow[]>('created', []);
  created.push(flow);
  await writeFlowsKey('created', created);
  return flow;
}

/** Apply a patch to a flow locally (override for seeded, in-place for local) and return the merged flow. */
export async function demoUpdateFlow(current: FlowDefinition, patch: Partial<FlowDefinition>): Promise<FlowDefinition> {
  const merged: FlowDefinition = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (isDemoLocalId(current.id)) {
    const created = await readFlowsKey<DemoFlow[]>('created', []);
    const i = created.findIndex((f) => f.id === current.id);
    if (i !== -1) {
      created[i] = { ...created[i], ...patch, updatedAt: merged.updatedAt };
      await writeFlowsKey('created', created);
    }
  } else {
    const edits = await readFlowsKey<FlowEdits>('edits', {});
    edits[current.id] = { ...(edits[current.id] ?? {}), ...patch, updatedAt: merged.updatedAt };
    await writeFlowsKey('edits', edits);
  }
  return merged;
}

/** Remove a flow: drop a local one, or tombstone a seeded one. */
export async function demoDeleteFlow(flow: FlowDefinition): Promise<void> {
  if (isDemoLocalId(flow.id)) {
    const created = await readFlowsKey<DemoFlow[]>('created', []);
    await writeFlowsKey('created', created.filter((f) => f.id !== flow.id));
  } else {
    const [deleted, edits] = await Promise.all([
      readFlowsKey<string[]>('deleted', []),
      readFlowsKey<FlowEdits>('edits', {}),
    ]);
    if (!deleted.includes(flow.id)) deleted.push(flow.id);
    delete edits[flow.id];
    await Promise.all([writeFlowsKey('deleted', deleted), writeFlowsKey('edits', edits)]);
  }
}
