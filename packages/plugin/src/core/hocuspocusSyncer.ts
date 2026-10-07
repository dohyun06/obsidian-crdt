import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { RECONNECT_MAX_DELAY_MS } from "@obsidian-crdt/shared";
import type * as Y from "yjs";
import type { DocSyncer, DocSyncHandle } from "./ports";
import { assertSecureServerUrl } from "./serverUrl";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface HocuspocusSyncerOptions {
  url: string;
  token: string;
  onAuthFailed: () => void;
  onStatus?: (status: ConnectionStatus) => void;
}

/** All documents share one WebSocket (multiplexing). */
export class HocuspocusSyncer implements DocSyncer {
  private readonly socket: HocuspocusProviderWebsocket;
  private readonly providers = new Set<HocuspocusProvider>();
  private authFailed = false;

  constructor(private readonly options: HocuspocusSyncerOptions) {
    assertSecureServerUrl(options.url);
    this.socket = new HocuspocusProviderWebsocket({
      url: options.url,
      maxDelay: RECONNECT_MAX_DELAY_MS,
      onStatus: ({ status }) => options.onStatus?.(status as ConnectionStatus),
    });
  }

  connect(docName: string, doc: Y.Doc): DocSyncHandle {
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: docName,
      document: doc,
      token: this.options.token,
      onAuthenticationFailed: () => this.handleAuthFailed(),
    });
    // No presence until an editor binds this doc: a non-null local state is renewed every 15 s for every
    // subscribed doc (thousands of notes → constant awareness traffic). attachSync publishes it on bind.
    provider.awareness?.setLocalState(null);
    provider.attach();
    this.providers.add(provider);
    return {
      awareness: provider.awareness ?? null,
      isSynced: () => provider.isSynced,
      whenSynced: () => waitForSynced(provider),
      destroy: () => {
        this.providers.delete(provider);
        provider.destroy();
      },
    };
  }

  /** Disconnects without forgetting documents; edits keep accumulating locally. */
  pause(): void {
    this.socket.disconnect();
  }

  resume(): void {
    if (this.authFailed) return;
    // disconnect() closes asynchronously. If resume() lands before the close event, connect() returns early
    // (still "connected") without re-arming, and the close would then leave the socket down for good.
    this.socket.shouldConnect = true;
    void this.socket.connect();
  }

  destroy(): void {
    for (const provider of this.providers) provider.destroy();
    this.providers.clear();
    this.socket.destroy();
  }

  /** A rejected token will not start working by retrying; stop until the user fixes the settings. */
  private handleAuthFailed(): void {
    if (this.authFailed) return;
    this.authFailed = true;
    this.socket.disconnect();
    this.options.onAuthFailed();
  }
}

function waitForSynced(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve) => {
    const onSynced = () => {
      if (!provider.isSynced) return;
      provider.off("synced", onSynced);
      resolve();
    };
    provider.on("synced", onSynced);
  });
}
