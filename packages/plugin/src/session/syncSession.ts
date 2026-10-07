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
  /** The token was rejected. The session only pauses itself; the owner must stop it (after detaching editors). */
  onAuthFailed(): void;
  timing?: Partial<SyncTiming>;
}

/** One running sync: storage + syncer + engine, started and stopped together. */
export class SyncSession {
  private engine: SyncEngine | null = null;
  private storage: SessionStorage | null = null;
  private syncer: SessionSyncer | null = null;
  private connection: ConnectionStatus = "connecting";
  private stopped = false;
  private pauseRequested = false;
  private stopping: Promise<void> | null = null;
  private pausedPaths: readonly string[] = [];
  private current: SyncStatus = "stopped";

  constructor(private readonly deps: SessionDeps) {}

  get status(): SyncStatus {
    return this.current;
  }

  get editorSource(): EditorDocSource | null {
    return this.stopped ? null : this.engine;
  }

  /** True until start() has finished; a starting session can wait indefinitely for a first sync. */
  get isStarting(): boolean {
    return !this.stopped && (this.current === "starting" || this.current === "waiting-first-sync");
  }

  get pausedDeletePaths(): readonly string[] {
    return this.pausedPaths;
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    try {
      await this.startParts();
    } catch (error) {
      if (error instanceof EngineStoppedError) return void (await this.stopping?.catch(() => {})); // resolve once the stop finished
      const stoppedByOwner = this.stopped;
      await this.stop(); // release storage, syncer and engine
      if (!stoppedByOwner) this.setStatus("error");
      throw error;
    }
  }

  private async startParts(): Promise<void> {
    const storage = await this.deps.openStorage(this.deps.config);
    if (this.stopped) return storage.close(); // stop() ran while storage was opening
    this.storage = storage;
    this.syncer = this.deps.createSyncer(this.deps.config, {
      onAuthFailed: () => this.failAuth(),
      onStatus: (status) => this.onConnection(status),
    });
    if (this.pauseRequested) this.syncer.pause();
    this.engine = this.createEngine(storage, this.syncer);
    await this.engine.start();
    if (this.current === "starting" || this.current === "waiting-first-sync") this.setStatus(this.connection === "disconnected" ? "offline" : "connected");
  }

  /** Idempotent: every caller resolves only when the first stop has fully finished. */
  stop(): Promise<void> {
    this.stopping ??= this.release().catch((error) => {
      this.stopping = null; // a later stop() retries whatever is left
      throw error;
    });
    return this.stopping;
  }

  private async release(): Promise<void> {
    this.stopped = true;
    try {
      await this.engine?.stop();
      this.engine = null;
    } finally {
      await this.releaseStorageAndSyncer();
    }
    if (this.current !== "auth-failed" && this.current !== "error") this.setStatus("stopped");
  }

  private async releaseStorageAndSyncer(): Promise<void> {
    try {
      await this.storage?.flush();
    } finally {
      this.storage?.close();
      this.storage = null;
      this.syncer?.destroy();
      this.syncer = null;
    }
  }

  pause(): void {
    this.pauseRequested = true;
    this.syncer?.pause();
  }

  resume(): void {
    this.pauseRequested = false;
    if (this.current === "auth-failed") return;
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
    if (notice.kind === "mass-delete-paused") {
      this.pausedPaths = notice.paths;
      this.setStatus("deletes-paused");
    }
  }

  private onConnection(status: ConnectionStatus): void {
    this.connection = status;
    if (["auth-failed", "deletes-paused", "stopped", "starting", "waiting-first-sync"].includes(this.current)) return;
    if (status === "connected") this.setStatus("connected");
    if (status === "disconnected") this.setStatus("offline");
  }

  private failAuth(): void {
    if (this.stopped || this.current === "auth-failed") return;
    const wasStarting = this.isStarting;
    this.setStatus("auth-failed");
    this.syncer?.pause();
    if (wasStarting) {
      // The owner's restart chain is blocked on this very start(), so stop directly; start() then returns.
      this.stop().catch((error) => console.error("CRDT Sync: stopping after auth failure failed", error));
      return;
    }
    this.deps.onAuthFailed();
  }

  private leavePausedDeletes(): void {
    this.pausedPaths = [];
    if (this.current === "deletes-paused") this.setStatus(this.connection === "disconnected" ? "offline" : "connected");
  }

  private setStatus(status: SyncStatus): void {
    if (this.current === status) return;
    this.current = status;
    this.deps.onStatus(status);
  }
}
