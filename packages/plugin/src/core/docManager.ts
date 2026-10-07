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

  constructor(private readonly deps: DocManagerDeps) {}

  async open(fileId: string): Promise<OpenedDoc> {
    let slot = this.slots.get(fileId);
    if (!slot) {
      slot = this.createSlot(fileId);
      this.slots.set(fileId, slot);
    }
    return (await slot).opened;
  }

  async closeAll(): Promise<void> {
    const slots = await Promise.all(this.slots.values());
    this.slots.clear();
    for (const { opened, persisted } of slots) {
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
    return { opened: { fileId, doc, text: doc.getText(CONTENT_TEXT_KEY), sync }, persisted };
  }
}
