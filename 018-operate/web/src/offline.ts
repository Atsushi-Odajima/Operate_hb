/**
 * Offline storage (IndexedDB). Only documents the server allows (classification policy) are saved, with their version
 * and effective date. On reconnect every copy is re-checked: superseded copies are refreshed, retired / no-longer-
 * permitted copies are deleted. Nothing is cached automatically by the service worker for API responses.
 */
import { api } from './api';

const DB = 'operate-offline';
function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('docs', { keyPath: 'documentId' });
      r.result.createObjectStore('queue', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function store(name: string, mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}
const wrap = <T,>(req: IDBRequest<T>) => new Promise<T>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export interface OfflineDoc { documentId: string; versionId: string; version: string; title: string; content: any; classification: string; effectiveDate: string | null; publishedAt: string | null; docNumber: string | null; savedAt: string; state?: string; }

export async function saveOffline(documentId: string) {
  const d = await api.get<OfflineDoc>(`/api/documents/${documentId}/offline`);
  await wrap((await store('docs', 'readwrite')).put({ ...d, state: 'current' }));
  return d;
}
export async function listOffline(): Promise<OfflineDoc[]> { return wrap((await store('docs', 'readonly')).getAll()); }
export async function getOffline(id: string): Promise<OfflineDoc | undefined> { return wrap((await store('docs', 'readonly')).get(id)); }
export async function removeOffline(id: string) { await wrap((await store('docs', 'readwrite')).delete(id)); }
export async function clearOffline() {
  try {
    await wrap((await store('docs', 'readwrite')).clear());
    await wrap((await store('queue', 'readwrite')).clear());
  } catch { /* no IDB */ }
}

/** Returns a summary of what changed so the UI can warn the user. */
export async function recheckOffline(): Promise<{ updated: string[]; removed: string[] }> {
  const docs = await listOffline();
  if (!docs.length) return { updated: [], removed: [] };
  const res = await api.post<Array<{ documentId: string; versionId: string; state: string }>>('/api/offline/check', { items: docs.map((d) => ({ documentId: d.documentId, versionId: d.versionId })) });
  const updated: string[] = [], removed: string[] = [];
  for (const r of res) {
    const d = docs.find((x) => x.documentId === r.documentId)!;
    if (r.state === 'superseded') { try { await saveOffline(r.documentId); updated.push(d.title); } catch { await removeOffline(r.documentId); removed.push(d.title); } }
    else if (r.state !== 'current') { await removeOffline(r.documentId); removed.push(d.title); }
  }
  return { updated, removed };
}

// ---- queued (non-critical) operations: checklist item ticks only. Approvals / attestations / quiz submits are never queued.
export interface QueuedOp { key: string; method: 'PATCH' | 'POST'; url: string; body: unknown; label: string; createdAt: string }
export async function enqueue(op: QueuedOp) { await wrap((await store('queue', 'readwrite')).put(op)); }
export async function pending(): Promise<QueuedOp[]> { try { return await wrap((await store('queue', 'readonly')).getAll()); } catch { return []; } }
export async function flushQueue(): Promise<number> {
  const ops = (await pending()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let n = 0;
  for (const op of ops) {
    try {
      if (op.method === 'PATCH') await api.patch(op.url, op.body); else await api.post(op.url, op.body);
      await wrap((await store('queue', 'readwrite')).delete(op.key));
      n++;
    } catch (e: any) {
      if (e?.status === 0) break; // still offline
      await wrap((await store('queue', 'readwrite')).delete(op.key)); // rejected by server: drop, server state wins
    }
  }
  return n;
}
