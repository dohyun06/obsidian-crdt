import * as Y from "yjs";
import { buildFileDocName, CONTENT_TEXT_KEY } from "@obsidian-crdt/shared";
import type { DocPersistence, DocSyncer, DocSyncHandle, PersistedDoc } from "./ports";

/** Origin for Y.Text edits that came from the disk; they must not be written back to disk. */
export const DISK_ORIGIN = Symbol("disk");

export interface OpenedDoc {
  fileId: string;
  doc: Y.Doc;
  text: Y.Text;
  sync: DocSyncHandle;
}

export interface DocManagerDeps {
  vaultId: string;
  syncer: DocSyncer;
  persistence: DocPersistence;
  onTextChanged: (fileId: string) => void;
}

interface DocSlot {
  opened: OpenedDoc;
  persisted: PersistedDoc;
}

export class DocManager {
  private readonly slots = new Map<string, Promise<DocSlot>>();
  private readonly ready = new Map<string, OpenedDoc>();

  constructor(private readonly deps: DocManagerDeps) {}

  async open(fileId: string): Promise<OpenedDoc> {
    let slot = this.slots.get(fileId);
    if (!slot) {
      const created = this.createSlot(fileId);
      slot = created;
      this.slots.set(fileId, created);
      // A failed attach (e.g. a storage hiccup) must not poison this file for the rest of the session.
      created.catch(() => {
        if (this.slots.get(fileId) === created) this.slots.delete(fileId);
      });
    }
    return (await slot).opened;
  }

  /** The doc if it has finished opening; never starts an open. */
  peek(fileId: string): OpenedDoc | undefined {
    return this.ready.get(fileId);
  }

  async closeAll(): Promise<void> {
    const settled = await Promise.allSettled(this.slots.values());
    this.slots.clear();
    this.ready.clear();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const { opened, persisted } = result.value;
      opened.sync.destroy();
      persisted.destroy();
      opened.doc.destroy();
    }
  }

  private async createSlot(fileId: string): Promise<DocSlot> {
    const docName = buildFileDocName(this.deps.vaultId, fileId);
    const doc = new Y.Doc();
    const persisted = await this.deps.persistence.attach(docName, doc);
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== DISK_ORIGIN) this.deps.onTextChanged(fileId);
    });
    const sync = this.deps.syncer.connect(docName, doc);
    const opened: OpenedDoc = { fileId, doc, text: doc.getText(CONTENT_TEXT_KEY), sync };
    this.ready.set(fileId, opened);
    return { opened, persisted };
  }
}
