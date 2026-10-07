import type { FileRecord, StoragePort } from "../../src/core/ports";

export class MemoryStorage implements StoragePort {
  readonly records = new Map<string, FileRecord>();
  private readonly flags = new Map<string, boolean>();

  async loadRecords(): Promise<Array<[string, FileRecord]>> {
    return [...this.records.entries()].map(([id, record]): [string, FileRecord] => [id, { ...record }]);
  }

  async saveRecord(fileId: string, record: FileRecord): Promise<void> {
    this.records.set(fileId, { ...record });
  }

  async deleteRecord(fileId: string): Promise<void> {
    this.records.delete(fileId);
  }

  async getFlag(key: string): Promise<boolean> {
    return this.flags.get(key) ?? false;
  }

  async setFlag(key: string, value: boolean): Promise<void> {
    this.flags.set(key, value);
  }
}
