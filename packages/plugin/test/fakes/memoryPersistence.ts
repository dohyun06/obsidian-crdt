import * as Y from "yjs";
import type { DocPersistence, PersistedDoc } from "../../src/core/ports";

/** Survives engine restarts in tests, like IndexedDB does on a device. */
export class MemoryPersistence implements DocPersistence {
  private readonly saved = new Map<string, Uint8Array>();

  async attach(docName: string, doc: Y.Doc): Promise<PersistedDoc> {
    const state = this.saved.get(docName);
    if (state) Y.applyUpdate(doc, state, this);
    const save = () => this.saved.set(docName, Y.encodeStateAsUpdate(doc));
    doc.on("update", save);
    save();
    return { destroy: () => doc.off("update", save) };
  }
}
