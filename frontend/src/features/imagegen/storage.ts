/**
 * Local-only persistence for the image-generation plaza.
 *
 * History metadata lives in `localStorage`; the generated pixels live in
 * IndexedDB keyed by history id, because a handful of 4K images blows past the
 * ~5MB localStorage quota immediately. Nothing here is ever sent to a server —
 * that matches the source page's contract that generated images stay on the
 * user's machine.
 */

const DB_NAME = 'imgGenHistoryDB'
const DB_VERSION = 1
const DB_STORE = 'images'
const HISTORY_META_KEY = 'imgGenHistoryStandaloneMeta'
/** Legacy key from the NewAPI imagegen page; read once so history survives the port. */
const LEGACY_HISTORY_KEY = 'imgGenHistoryStandalone'
const PREVIEW_SIZE_KEY = 'imgGenPreviewSize'
export const HISTORY_LIMIT = 60

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode / quota exhausted — the page still works, just without memory.
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function loadPreviewSize(): number {
  const raw = safeGet(PREVIEW_SIZE_KEY)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 60 && parsed <= 100 ? parsed : 92
}

export function savePreviewSize(size: number): void {
  safeSet(PREVIEW_SIZE_KEY, String(size))
}

// ==================== IndexedDB ====================

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode)
    const request = run(tx.objectStore(DB_STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

/** Store the decoded image list for one history row as a structured array. */
export async function saveHistoryImages(id: string, images: string[]): Promise<void> {
  if (!id) return
  if (!images.length) {
    await deleteHistoryImages(id)
    return
  }
  await withStore('readwrite', (store) => store.put(images, id))
}

export async function loadHistoryImages(id: string): Promise<string[]> {
  if (!id) return []
  try {
    const value = await withStore<string[] | undefined>('readonly', (store) => store.get(id) as IDBRequest<string[] | undefined>)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export async function deleteHistoryImages(id: string): Promise<void> {
  if (!id) return
  try {
    await withStore('readwrite', (store) => store.delete(id))
  } catch {
    // ignore
  }
}

export async function clearHistoryImages(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.clear())
  } catch {
    // ignore
  }
}

// ==================== History metadata ====================

export function readRawHistory(): unknown[] {
  const raw = safeGet(HISTORY_META_KEY) ?? safeGet(LEGACY_HISTORY_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeRawHistory(items: unknown[]): void {
  safeSet(HISTORY_META_KEY, JSON.stringify(items))
  safeRemove(LEGACY_HISTORY_KEY)
}

/** Drop metadata for rows that are no longer in the list. */
export async function pruneHistoryImages(keepIds: string[]): Promise<void> {
  const keep = new Set(keepIds)
  let keys: IDBValidKey[]
  try {
    keys = await withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
  } catch {
    return
  }
  await Promise.all(keys.map((key) => (keep.has(String(key)) ? Promise.resolve() : deleteHistoryImages(String(key)))))
}
