export const DB_VERSION = 1;
export const STORE_RECORDS = "records";
export const STORE_FLAGS = "flags";
export const STORE_DOCS = "docs";
const STORES = [STORE_RECORDS, STORE_FLAGS, STORE_DOCS] as const;

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/** One database per local vault + sync vault id (spec §3.2 deviation: not one database per document). */
export function openSyncDatabase(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StorageUnavailableError(`cannot open IndexedDB "${name}": ${request.error?.message ?? "unknown error"}`));
    request.onblocked = () => reject(new StorageUnavailableError(`IndexedDB "${name}" is blocked by another connection`));
  });
}

export function runRequest<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  makeRequest: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = makeRequest(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new StorageUnavailableError(`IndexedDB ${mode} on "${store}" failed`));
    transaction.onabort = () => reject(transaction.error ?? new StorageUnavailableError(`IndexedDB ${mode} on "${store}" aborted`));
  });
}
