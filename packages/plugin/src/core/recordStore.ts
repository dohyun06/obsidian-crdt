import type { FileRecord, StoragePort } from "./ports";

/** Cached view of this device's fileId → {path, base} records. Reads are synchronous. */
export class RecordStore {
  private readonly byId = new Map<string, FileRecord>();
  private readonly idByPath = new Map<string, string>();

  private constructor(private readonly storage: StoragePort) {}

  static async load(storage: StoragePort): Promise<RecordStore> {
    const store = new RecordStore(storage);
    for (const [fileId, record] of await storage.loadRecords()) store.cache(fileId, record);
    return store;
  }

  get(fileId: string): FileRecord | null {
    return this.byId.get(fileId) ?? null;
  }

  findIdByPath(path: string): string | null {
    return this.idByPath.get(path) ?? null;
  }

  entries(): Array<[string, FileRecord]> {
    return [...this.byId.entries()];
  }

  async set(fileId: string, record: FileRecord): Promise<void> {
    this.uncache(fileId);
    this.cache(fileId, record);
    await this.storage.saveRecord(fileId, record);
  }

  async delete(fileId: string): Promise<void> {
    this.uncache(fileId);
    await this.storage.deleteRecord(fileId);
  }

  private cache(fileId: string, record: FileRecord): void {
    this.byId.set(fileId, record);
    this.idByPath.set(record.path, fileId);
  }

  private uncache(fileId: string): void {
    const previous = this.byId.get(fileId);
    if (!previous) return;
    this.byId.delete(fileId);
    if (this.idByPath.get(previous.path) === fileId) this.idByPath.delete(previous.path);
  }
}
