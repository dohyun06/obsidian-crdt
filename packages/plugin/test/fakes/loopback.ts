import * as Y from "yjs";
import type { DocSyncer, DocSyncHandle } from "../../src/core/ports";

/** In-process stand-in for the sync server: one authoritative Y.Doc per document name. */
export class LoopbackHub {
  private readonly docs = new Map<string, Y.Doc>();

  serverDoc(docName: string): Y.Doc {
    let doc = this.docs.get(docName);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(docName, doc);
    }
    return doc;
  }

  serverText(docName: string): string {
    return this.serverDoc(docName).getText("content").toString();
  }
}

class Link {
  private active = false;
  private resolveSynced: () => void = () => {};
  private synced: Promise<void> = this.resetSynced();

  constructor(
    readonly docName: string,
    private readonly server: Y.Doc,
    private readonly client: Y.Doc,
  ) {}

  private readonly fromServer = (update: Uint8Array, origin: unknown) => {
    if (origin !== this) Y.applyUpdate(this.client, update, this);
  };

  private readonly fromClient = (update: Uint8Array, origin: unknown) => {
    if (origin !== this) Y.applyUpdate(this.server, update, this);
  };

  get isUp(): boolean {
    return this.active;
  }

  whenSynced(): Promise<void> {
    return this.synced;
  }

  up(): void {
    if (this.active) return;
    this.active = true;
    Y.applyUpdate(this.server, Y.encodeStateAsUpdate(this.client, Y.encodeStateVector(this.server)), this);
    Y.applyUpdate(this.client, Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(this.client)), this);
    this.server.on("update", this.fromServer);
    this.client.on("update", this.fromClient);
    this.resolveSynced();
  }

  down(): void {
    if (!this.active) return;
    this.active = false;
    this.server.off("update", this.fromServer);
    this.client.off("update", this.fromClient);
    this.synced = this.resetSynced();
  }

  private resetSynced(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveSynced = resolve;
    });
  }
}

export class LoopbackSyncer implements DocSyncer {
  private online: boolean;
  private readonly links = new Set<Link>();

  constructor(
    private readonly hub: LoopbackHub,
    options: { online?: boolean } = {},
  ) {
    this.online = options.online ?? true;
  }

  connect(docName: string, doc: Y.Doc): DocSyncHandle {
    const link = new Link(docName, this.hub.serverDoc(docName), doc);
    this.links.add(link);
    if (this.online) link.up();
    return {
      isSynced: () => link.isUp,
      whenSynced: () => link.whenSynced(),
      destroy: () => {
        link.down();
        this.links.delete(link);
      },
    };
  }

  setOnline(online: boolean): void {
    this.online = online;
    for (const link of this.links) {
      if (online) link.up();
      else link.down();
    }
  }

  /** Connects one document only, e.g. the index arriving before a file's text does. */
  setDocOnline(docName: string): void {
    for (const link of this.links) if (link.docName === docName) link.up();
  }

  get linkCount(): number {
    return this.links.size;
  }
}
