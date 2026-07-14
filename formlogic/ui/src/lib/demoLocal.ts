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
const FORM_BINDINGS_STORE = 'formFlowBindings'; // per-form keys below; demo overlay for /forms/{id}/flow-bindings
const DB_VERSION = 3;

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
      if (!req.result.objectStoreNames.contains(FORM_BINDINGS_STORE)) {
        req.result.createObjectStore(FORM_BINDINGS_STORE);
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

async function readFormBindingsKey<T>(formId: string, key: string, fallback: T): Promise<T> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(FORM_BINDINGS_STORE, 'readonly');
      const rq = tx.objectStore(FORM_BINDINGS_STORE).get(`${formId}:${key}`);
      rq.onsuccess = () => resolve(rq.result === undefined ? fallback : (rq.result as T));
      rq.onerror = () => reject(rq.error);
    });
  } catch {
    return fallback;
  }
}

async function writeFormBindingsKey(formId: string, key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FORM_BINDINGS_STORE, 'readwrite');
      tx.objectStore(FORM_BINDINGS_STORE).put(value, `${formId}:${key}`);
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
      const tx = db.transaction([STORE, FLOWS_STORE, FORM_BINDINGS_STORE], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(FLOWS_STORE).clear();
      tx.objectStore(FORM_BINDINGS_STORE).clear();
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
import type { FlowBinding, FlowBindingMode, FlowDefinition } from '../types/flows';

type DemoFlow = FlowDefinition & { _local: true };
type FlowEdits = Record<string, Partial<FlowDefinition>>;
type DemoFormBinding = FlowBinding & { _local: true };
type FormBindingEdits = Record<string, Partial<FlowBinding>>;

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

// â”€â”€ Form flow-binding overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Demo form-flow bindings mirror the flow overlay but are keyed per formId. They cover only
// workspace-scope /forms/{id}/flow-bindings rows; app-scoped bindings stay server-read-only.
function formBindingCreatedKey() { return 'created'; }
function formBindingEditsKey() { return 'edits'; }
function formBindingDeletedKey() { return 'deleted'; }

function asBindingMode(value: unknown): FlowBindingMode | undefined {
  return value === 'sync' || value === 'async' || value === 'background' || value === 'manual' ? value : undefined;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArrayOrNull<T>(value: unknown): T[] | null | undefined {
  if (value === null) return null;
  return Array.isArray(value) ? value as T[] : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function formBindingPatchFromPayload(formId: string, payload: Record<string, unknown>): Partial<FlowBinding> {
  const patch: Partial<FlowBinding> = { appId: null, formId };
  if (typeof payload.connectorId === 'string' || payload.connectorId === null) patch.connectorId = payload.connectorId;
  if (typeof payload.flowDefinitionId === 'string') patch.flowDefinitionId = payload.flowDefinitionId;
  if (typeof payload.flow === 'string') patch.flow = payload.flow;
  if (typeof payload.event === 'string') patch.event = payload.event;
  const mode = asBindingMode(payload.mode);
  if (mode) patch.mode = mode;
  const condition = asRecordOrNull(payload.condition);
  if (condition !== undefined) patch.condition = condition as FlowBinding['condition'];
  const inputMap = asRecordOrNull(payload.inputMap);
  if (inputMap !== undefined) patch.inputMap = inputMap;
  const outputActions = asArrayOrNull<NonNullable<FlowBinding['outputActions']>[number]>(payload.outputActions);
  if (outputActions !== undefined) patch.outputActions = outputActions as FlowBinding['outputActions'];
  const timeoutMs = numberOrUndefined(payload.timeoutMs);
  if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
  const retryPolicy = asRecordOrNull(payload.retryPolicy);
  if (retryPolicy !== undefined) patch.retryPolicy = retryPolicy as FlowBinding['retryPolicy'];
  const fallbackPolicy = asRecordOrNull(payload.fallbackPolicy);
  if (fallbackPolicy !== undefined) patch.fallbackPolicy = fallbackPolicy as FlowBinding['fallbackPolicy'];
  if (typeof payload.enabled === 'boolean') patch.enabled = payload.enabled;
  const sortOrder = numberOrUndefined(payload.sortOrder);
  if (sortOrder !== undefined) patch.sortOrder = sortOrder;
  return patch;
}

/** Pure per-form binding overlay merge. Local creates first, then seeded rows with deletes/edits. */
export function mergeFormBindingOverlay(
  formId: string,
  serverRows: FlowBinding[],
  overlay: { created: FlowBinding[]; edits: FormBindingEdits; deleted: string[] },
): FlowBinding[] {
  const deletedSet = new Set(overlay.deleted);
  const seeded = serverRows
    .filter((binding) => !deletedSet.has(binding.id))
    .map((binding) => (overlay.edits[binding.id] ? { ...binding, ...overlay.edits[binding.id] } : binding));
  const local = overlay.created.filter((binding) => binding.formId === formId && !deletedSet.has(binding.id));
  return [...local, ...seeded];
}

/** Merge server-seeded standalone form bindings with this browser's demo overlay. */
export async function demoApplyFormBindingOverlay(formId: string, serverRows: FlowBinding[]): Promise<FlowBinding[]> {
  const [edits, deleted, created] = await Promise.all([
    readFormBindingsKey<FormBindingEdits>(formId, formBindingEditsKey(), {}),
    readFormBindingsKey<string[]>(formId, formBindingDeletedKey(), []),
    readFormBindingsKey<DemoFormBinding[]>(formId, formBindingCreatedKey(), []),
  ]);
  return mergeFormBindingOverlay(formId, serverRows, { created, edits, deleted });
}

/** Persist a new standalone form binding locally and return the synthetic binding. */
export async function demoCreateFormBinding(formId: string, payload: Record<string, unknown>): Promise<FlowBinding> {
  const now = new Date().toISOString();
  const patch = formBindingPatchFromPayload(formId, payload);
  const flow = patch.flow ?? patch.flowDefinitionId ?? '';
  const binding: DemoFormBinding = {
    id: 'demolocal_' + uuid(),
    appId: null,
    formId,
    connectorId: patch.connectorId ?? null,
    flowDefinitionId: patch.flowDefinitionId ?? flow,
    flow,
    event: patch.event ?? 'form.submitted',
    mode: patch.mode ?? 'async',
    condition: patch.condition ?? null,
    inputMap: patch.inputMap ?? null,
    outputActions: patch.outputActions ?? null,
    timeoutMs: patch.timeoutMs ?? 30000,
    retryPolicy: patch.retryPolicy ?? null,
    fallbackPolicy: patch.fallbackPolicy ?? null,
    enabled: patch.enabled ?? true,
    sortOrder: patch.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
    _local: true,
  };
  const created = await readFormBindingsKey<DemoFormBinding[]>(formId, formBindingCreatedKey(), []);
  created.push(binding);
  await writeFormBindingsKey(formId, formBindingCreatedKey(), created);
  return binding;
}

/** Apply a local patch to a standalone form binding; seeded rows store patch overrides. */
export async function demoUpdateFormBinding(formId: string, bindingId: string, payload: Record<string, unknown>): Promise<FlowBinding | null> {
  const updatedAt = new Date().toISOString();
  const patch: Partial<FlowBinding> = { ...formBindingPatchFromPayload(formId, payload), updatedAt };
  if (isDemoLocalId(bindingId)) {
    const created = await readFormBindingsKey<DemoFormBinding[]>(formId, formBindingCreatedKey(), []);
    const i = created.findIndex((binding) => binding.id === bindingId);
    if (i === -1) return null;
    created[i] = { ...created[i], ...patch, updatedAt, _local: true };
    await writeFormBindingsKey(formId, formBindingCreatedKey(), created);
    return created[i];
  }

  const edits = await readFormBindingsKey<FormBindingEdits>(formId, formBindingEditsKey(), {});
  edits[bindingId] = { ...(edits[bindingId] ?? {}), ...patch };
  await writeFormBindingsKey(formId, formBindingEditsKey(), edits);
  return null;
}

/** Delete a standalone form binding: remove local rows or tombstone seeded rows. */
export async function demoDeleteFormBinding(formId: string, bindingId: string): Promise<void> {
  if (isDemoLocalId(bindingId)) {
    const created = await readFormBindingsKey<DemoFormBinding[]>(formId, formBindingCreatedKey(), []);
    await writeFormBindingsKey(formId, formBindingCreatedKey(), created.filter((binding) => binding.id !== bindingId));
    return;
  }

  const [deleted, edits] = await Promise.all([
    readFormBindingsKey<string[]>(formId, formBindingDeletedKey(), []),
    readFormBindingsKey<FormBindingEdits>(formId, formBindingEditsKey(), {}),
  ]);
  if (!deleted.includes(bindingId)) deleted.push(bindingId);
  delete edits[bindingId];
  await Promise.all([
    writeFormBindingsKey(formId, formBindingDeletedKey(), deleted),
    writeFormBindingsKey(formId, formBindingEditsKey(), edits),
  ]);
}
