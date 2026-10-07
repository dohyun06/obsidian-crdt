import * as Y from "yjs";
import type { DocPersistence, PersistedDoc } from "../core/ports";
import { runRequest, STORE_DOCS } from "./idb";

export const DOC_SAVE_DEBOUNCE_MS = 300;
export const DOC_SAVE_MAX_WAIT_MS = 2000;

export interface IdbDocPersistenceOptions {
  saveDebounceMs?: number;
  onError: (error: unknown) => void;
}

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  doc: Y.Doc;
}

export class IdbDocPersistence implements DocPersistence {
  private readonly pending = new Map<string, PendingSave>();
  private readonly dirty = new Map<string, Y.Doc>();
  private readonly writes = new Set<Promise<void>>();

  constructor(
    private readonly db: IDBDatabase,
    private readonly options: IdbDocPersistenceOptions,
  ) {}

  get pendingWrites(): number {
    return this.pending.size + this.writes.size;
  }

  async attach(docName: string, doc: Y.Doc): Promise<PersistedDoc> {
    const state = await runRequest<unknown>(this.db, STORE_DOCS, "readonly", (store) => store.get(docName));
    if (state instanceof Uint8Array) Y.applyUpdate(doc, state, this);
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== this) this.schedule(docName, doc);
    };
    doc.on("update", onUpdate);
    return {
      destroy: () => {
        doc.off("update", onUpdate);
        this.flush(docName);
      },
    };
  }

  /** Writes every pending save now, retries dirty docs once (on first failure), waits for all writes. */
  async flushAll(): Promise<void> {
    for (const docName of [...this.pending.keys()]) this.flush(docName);
    for (const [docName, doc] of [...this.dirty]) {
      this.writeDoc(docName, doc);
    }
    await Promise.allSettled([...this.writes]);
  }

  private schedule(docName: string, doc: Y.Doc): void {
    const existing = this.pending.get(docName);
    if (existing) clearTimeout(existing.timer);
    const debounceMs = this.options.saveDebounceMs ?? DOC_SAVE_DEBOUNCE_MS;
    const timer = setTimeout(() => this.flush(docName), debounceMs);
    const maxWaitTimer = existing?.maxWaitTimer ?? setTimeout(() => this.flush(docName), DOC_SAVE_MAX_WAIT_MS);
    this.pending.set(docName, { timer, maxWaitTimer, doc });
    this.dirty.delete(docName);
  }

  private flush(docName: string): void {
    const entry = this.pending.get(docName);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
    this.pending.delete(docName);
    this.writeDoc(docName, entry.doc);
  }

  private writeDoc(docName: string, doc: Y.Doc): void {
    const state = Y.encodeStateAsUpdate(doc);
    const write = runRequest(this.db, STORE_DOCS, "readwrite", (store) => store.put(state, docName))
      .then(() => {
        this.dirty.delete(docName);
      })
      .catch((error: unknown) => {
        this.dirty.set(docName, doc);
        this.options.onError(error);
      });
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
  }
}
