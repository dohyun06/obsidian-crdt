import type * as Y from "yjs";

export type VaultEvent =
  | { type: "create"; path: string }
  | { type: "modify"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; oldPath: string; path: string };

/** The plugin's view of the vault on disk. Obsidian implements it in Plan 2. */
export interface VaultPort {
  listFiles(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** Writes `next` only if the file still holds `expected` (`null` = must not exist). Returns false if the disk changed. */
  replace(path: string, expected: string | null, next: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Moves to the vault trash (recoverable). */
  trash(path: string): Promise<void>;
  onEvent(listener: (event: VaultEvent) => void): () => void;
}

export interface FileRecord {
  /** Where this device has the file on disk. */
  path: string;
  /** Text last agreed between disk and Y.Text on this device; null before the first sync. */
  base: string | null;
}

export interface StoragePort {
  loadRecords(): Promise<Array<[string, FileRecord]>>;
  saveRecord(fileId: string, record: FileRecord): Promise<void>;
  deleteRecord(fileId: string): Promise<void>;
  getFlag(key: string): Promise<boolean>;
  setFlag(key: string, value: boolean): Promise<void>;
}

export interface DocSyncHandle {
  isSynced(): boolean;
  whenSynced(): Promise<void>;
  destroy(): void;
}

export interface DocSyncer {
  connect(docName: string, doc: Y.Doc): DocSyncHandle;
}

export interface PersistedDoc {
  destroy(): void;
}

/** Loads saved state into `doc` before resolving, then keeps saving its updates. */
export interface DocPersistence {
  attach(docName: string, doc: Y.Doc): Promise<PersistedDoc>;
}
