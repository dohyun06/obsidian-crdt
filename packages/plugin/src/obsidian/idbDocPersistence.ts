import * as Y from "yjs";
import type { DocPersistence, PersistedDoc } from "../core/ports";
import { runRequest, STORE_DOCS } from "./idb";

export const DOC_SAVE_DEBOUNCE_MS = 300;

export interface IdbDocPersistenceOptions {
  saveDebounceMs?: number;
  onError?: (error: unknown) => void;
}

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  doc: Y.Doc;
}

export class IdbDocPersistence implements DocPersistence {
  private readonly pending = new Map<string, PendingSave>();
  private readonly writes = new Set<Promise<void>>();

  constructor(
    private readonly db: IDBDatabase,
    private readonly options: IdbDocPersistenceOptions = {},
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

  /** Writes every pending save now and waits for all writes; call before closing the database. */
  async flushAll(): Promise<void> {
    for (const docName of [...this.pending.keys()]) this.flush(docName);
    await Promise.allSettled([...this.writes]);
  }

  private schedule(docName: string, doc: Y.Doc): void {
    const existing = this.pending.get(docName);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.flush(docName), this.options.saveDebounceMs ?? DOC_SAVE_DEBOUNCE_MS);
    this.pending.set(docName, { timer, doc });
  }

  private flush(docName: string): void {
    const entry = this.pending.get(docName);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(docName);
    const state = Y.encodeStateAsUpdate(entry.doc); // encode now: the doc may be destroyed right after
    const write = runRequest(this.db, STORE_DOCS, "readwrite", (store) => store.put(state, docName))
      .then(() => undefined)
      .catch((error: unknown) => this.options.onError?.(error));
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
  }
}
