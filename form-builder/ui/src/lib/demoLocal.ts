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
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
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
