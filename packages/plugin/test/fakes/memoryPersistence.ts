import * as Y from "yjs";
import type { DocPersistence, PersistedDoc } from "../../src/core/ports";

/** Survives engine restarts in tests, like IndexedDB does on a device. */
export class MemoryPersistence implements DocPersistence {
  private readonly saved = new Map<string, Uint8Array>();
  private readonly attached = new Map<string, Y.Doc>();

  async attach(docName: string, doc: Y.Doc): Promise<PersistedDoc> {
    const state = this.saved.get(docName);
    if (state) Y.applyUpdate(doc, state, this);
    this.attached.set(docName, doc);
    const save = () => this.saved.set(docName, Y.encodeStateAsUpdate(doc));
    doc.on("update", save);
    save();
    return { destroy: () => doc.off("update", save) };
  }

  /** The engine's live Y.Doc for a document, as an editor binding (yCollab) would see it. */
  attachedDoc(docName: string): Y.Doc {
    const doc = this.attached.get(docName);
    if (!doc) throw new Error(`MemoryPersistence: ${docName} was never attached`);
    return doc;
  }
}
