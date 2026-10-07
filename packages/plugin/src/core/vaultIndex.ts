import * as Y from "yjs";
import { INDEX_FILES_MAP_KEY, isSafeRelativePath, isValidFileId } from "@obsidian-crdt/shared";
import { buildConflictPath } from "./conflictPath";

export const INDEX_LOCAL_ORIGIN = Symbol("index-local");

export interface IndexEntry {
  fileId: string;
  path: string;
  deleted: boolean;
  createdAt: number;
}

export interface PathReassignment {
  fileId: string;
  fromPath: string;
  toPath: string;
}

export class UnknownFileIdError extends Error {
  constructor(fileId: string) {
    super(`unknown file id in index: ${fileId}`);
    this.name = "UnknownFileIdError";
  }
}

type EntryMap = Y.Map<unknown>;

export class VaultIndex {
  private readonly files: Y.Map<EntryMap>;

  constructor(
    private readonly doc: Y.Doc,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {
    this.files = doc.getMap<EntryMap>(INDEX_FILES_MAP_KEY);
  }

  register(path: string, createdAt: number): string {
    const fileId = this.createId();
    this.doc.transact(() => {
      const entry = new Y.Map<unknown>();
      this.files.set(fileId, entry);
      entry.set("path", path);
      entry.set("deleted", false);
      entry.set("createdAt", createdAt);
    }, INDEX_LOCAL_ORIGIN);
    return fileId;
  }

  get(fileId: string): IndexEntry | null {
    const raw = this.files.get(fileId);
    return raw ? readEntry(fileId, raw) : null;
  }

  /** Sorted by fileId so every device iterates in the same order. */
  entries(): IndexEntry[] {
    const result: IndexEntry[] = [];
    this.files.forEach((raw, fileId) => {
      const entry = readEntry(fileId, raw);
      if (entry) result.push(entry);
    });
    return result.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  }

  liveEntries(): IndexEntry[] {
    return this.entries().filter((entry) => !entry.deleted);
  }

  /** When several live entries share a path, the smallest fileId owns it. */
  findLiveByPath(path: string): IndexEntry | null {
    return this.liveEntries().find((entry) => entry.path === path) ?? null;
  }

  rename(fileId: string, path: string): void {
    this.updateField(fileId, "path", path);
  }

  markDeleted(fileId: string): void {
    this.updateField(fileId, "deleted", true);
  }

  planCollisionResolution(): PathReassignment[] {
    const byPath = new Map<string, IndexEntry[]>();
    for (const entry of this.liveEntries()) {
      byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry]);
    }
    const plan: PathReassignment[] = [];
    for (const group of byPath.values()) {
      for (const loser of group.slice(1)) {
        const toPath = buildConflictPath({ path: loser.path, label: "conflict", timestampMs: loser.createdAt, fileId: loser.fileId });
        plan.push({ fileId: loser.fileId, fromPath: loser.path, toPath });
      }
    }
    return plan;
  }

  applyReassignments(plan: PathReassignment[]): void {
    this.doc.transact(() => {
      for (const step of plan) this.files.get(step.fileId)?.set("path", step.toPath);
    }, INDEX_LOCAL_ORIGIN);
  }

  onRemoteChange(listener: () => void): () => void {
    const handler = (_events: unknown, transaction: Y.Transaction) => {
      if (transaction.origin !== INDEX_LOCAL_ORIGIN) listener();
    };
    this.files.observeDeep(handler);
    return () => this.files.unobserveDeep(handler);
  }

  private updateField(fileId: string, key: "path" | "deleted", value: string | boolean): void {
    const raw = this.files.get(fileId);
    if (!raw) throw new UnknownFileIdError(fileId);
    this.doc.transact(() => raw.set(key, value), INDEX_LOCAL_ORIGIN);
  }
}

/** Index entries come from other devices: validate before trusting them. */
function readEntry(fileId: string, raw: unknown): IndexEntry | null {
  if (!isValidFileId(fileId) || !(raw instanceof Y.Map)) return null;
  const path = raw.get("path");
  const deleted = raw.get("deleted");
  const createdAt = raw.get("createdAt");
  if (typeof path !== "string" || !isSafeRelativePath(path)) return null;
  if (typeof deleted !== "boolean" || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return { fileId, path, deleted, createdAt };
}
