import type { ConnectionStatus } from "../core/hocuspocusSyncer";
import type { SyncNotice } from "../core/notices";
import type { DocPersistence, DocSyncer, StoragePort, VaultPort } from "../core/ports";
import { EngineStoppedError, SyncEngine, type SyncTiming } from "../core/syncEngine";
import type { EditorDocSource } from "../editor/editorBridge";
import type { SessionConfig } from "../settings/settings";
import type { SyncStatus } from "./status";

export interface SessionSyncer extends DocSyncer {
  pause(): void;
  resume(): void;
  destroy(): void;
}

export interface SessionStorage {
  storage: StoragePort;
  persistence: DocPersistence;
  flush(): Promise<void>;
  close(): void;
}

export interface SyncerHandlers {
  onAuthFailed(): void;
  onStatus(status: ConnectionStatus): void;
}

export interface SessionDeps {
  config: SessionConfig;
  vault: VaultPort;
  openStorage(config: SessionConfig): Promise<SessionStorage>;
  createSyncer(config: SessionConfig, handlers: SyncerHandlers): SessionSyncer;
  isOpenInEditor(path: string): boolean;
  excludedPrefixes: readonly string[];
  onStatus(status: SyncStatus): void;
  onNotice(notice: SyncNotice): void;
  timing?: Partial<SyncTiming>;
}

/** One running sync: storage + syncer + engine, started and stopped together. */
export class SyncSession {
  private engine: SyncEngine | null = null;
  private storage: SessionStorage | null = null;
  private syncer: SessionSyncer | null = null;
  private connection: ConnectionStatus = "connecting";
  private stopped = false;
  private current: SyncStatus = "stopped";

  constructor(private readonly deps: SessionDeps) {}

  get status(): SyncStatus {
    return this.current;
  }

  get editorSource(): EditorDocSource | null {
    return this.stopped ? null : this.engine;
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    const storage = await this.deps.openStorage(this.deps.config);
    if (this.stopped) return storage.close(); // stop() ran while storage was opening
    this.storage = storage;
    this.syncer = this.deps.createSyncer(this.deps.config, {
      onAuthFailed: () => void this.failAuth(),
      onStatus: (status) => this.onConnection(status),
    });
    this.engine = this.createEngine(storage, this.syncer);
    try {
      await this.engine.start();
    } catch (error) {
      if (error instanceof EngineStoppedError) return;
      throw error;
    }
    if (this.current === "starting" || this.current === "waiting-first-sync") this.setStatus(this.connection === "disconnected" ? "offline" : "connected");
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.engine && !this.storage) return;
    this.stopped = true;
    const { engine, storage, syncer } = this;
    this.engine = null;
    this.storage = null;
    this.syncer = null;
    await engine?.stop();
    if (storage) {
      await storage.flush();
      storage.close();
    }
    syncer?.destroy();
    if (this.current !== "auth-failed") this.setStatus("stopped");
  }

  pause(): void {
    this.syncer?.pause();
  }

  resume(): void {
    this.syncer?.resume();
  }

  async confirmDeletes(): Promise<void> {
    await this.engine?.confirmPausedDeletes();
    this.leavePausedDeletes();
  }

  async restoreDeletes(): Promise<void> {
    await this.engine?.restorePausedDeletes();
    this.leavePausedDeletes();
  }

  private createEngine(storage: SessionStorage, syncer: SessionSyncer): SyncEngine {
    return new SyncEngine({
      vaultId: this.deps.config.vaultId,
      vault: this.deps.vault,
      storage: storage.storage,
      syncer,
      persistence: storage.persistence,
      isOpenInEditor: (path) => this.deps.isOpenInEditor(path),
      excludedPrefixes: this.deps.excludedPrefixes,
      notify: (notice) => this.onNotice(notice),
      timing: this.deps.timing,
    });
  }

  private onNotice(notice: SyncNotice): void {
    this.deps.onNotice(notice);
    if (notice.kind === "waiting-for-first-sync") this.setStatus("waiting-first-sync");
    if (notice.kind === "mass-delete-paused") this.setStatus("deletes-paused");
  }

  private onConnection(status: ConnectionStatus): void {
    this.connection = status;
    if (["auth-failed", "deletes-paused", "stopped", "starting", "waiting-first-sync"].includes(this.current)) return;
    if (status === "connected") this.setStatus("connected");
    if (status === "disconnected") this.setStatus("offline");
  }

  private async failAuth(): Promise<void> {
    this.setStatus("auth-failed");
    await this.stop();
  }

  private leavePausedDeletes(): void {
    if (this.current === "deletes-paused") this.setStatus(this.connection === "disconnected" ? "offline" : "connected");
  }

  private setStatus(status: SyncStatus): void {
    if (this.current === status) return;
    this.current = status;
    this.deps.onStatus(status);
  }
}
