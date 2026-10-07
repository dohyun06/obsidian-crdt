import type { FileRecord, StoragePort } from "../core/ports";
import { runRequest, STORE_FLAGS, STORE_RECORDS } from "./idb";

interface StoredRecord {
  fileId: string;
  path: string;
  base: string | null;
}

function toEntry(value: unknown): [string, FileRecord] | null {
  if (typeof value !== "object" || value === null) return null;
  const { fileId, path, base } = value as Record<string, unknown>;
  if (typeof fileId !== "string" || typeof path !== "string") return null;
  if (base !== null && typeof base !== "string") return null;
  return [fileId, { path, base }];
}

export class IdbStorage implements StoragePort {
  constructor(private readonly db: IDBDatabase) {}

  async loadRecords(): Promise<Array<[string, FileRecord]>> {
    const values = await runRequest<unknown[]>(this.db, STORE_RECORDS, "readonly", (store) => store.getAll());
    return values.map(toEntry).filter((entry): entry is [string, FileRecord] => entry !== null);
  }

  async saveRecord(fileId: string, record: FileRecord): Promise<void> {
    const stored: StoredRecord = { fileId, path: record.path, base: record.base };
    await runRequest(this.db, STORE_RECORDS, "readwrite", (store) => store.put(stored, fileId));
  }

  async deleteRecord(fileId: string): Promise<void> {
    await runRequest(this.db, STORE_RECORDS, "readwrite", (store) => store.delete(fileId));
  }

  async getFlag(key: string): Promise<boolean> {
    return (await runRequest<unknown>(this.db, STORE_FLAGS, "readonly", (store) => store.get(key))) === true;
  }

  async setFlag(key: string, value: boolean): Promise<void> {
    await runRequest(this.db, STORE_FLAGS, "readwrite", (store) => store.put(value, key));
  }
}
