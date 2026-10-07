import * as Y from "yjs";
import {
  buildIndexDocName,
  DISK_WRITE_DEBOUNCE_MS,
  INDEX_PASS_DEBOUNCE_MS,
  isSyncablePath,
  MASS_DELETE_THRESHOLD,
  MASS_DELETE_WINDOW_MS,
  normalizeVaultPath,
  RENAME_PAIR_WINDOW_MS,
} from "@obsidian-crdt/shared";
import { DocManager } from "./docManager";
import { EchoTrackingVault } from "./echoTrackingVault";
import { FileReconciler } from "./fileReconciler";
import { IndexApplier } from "./indexApplier";
import { LocalChangeHandler } from "./localChanges";
import { MassDeleteGuard } from "./massDeleteGuard";
import type { SyncNotice } from "./notices";
import type { DocPersistence, DocSyncer, DocSyncHandle, PersistedDoc, StoragePort, VaultEvent, VaultPort } from "./ports";
import { RecordStore } from "./recordStore";
import { KeyedDebouncer, SerialQueue, waitUntil } from "./scheduling";
import { StartupScan } from "./startupScan";
import { VaultIndex } from "./vaultIndex";

export const BOOTSTRAP_FLAG = "bootstrapped";

export interface SyncTiming {
  diskWriteDebounceMs: number;
  indexPassDebounceMs: number;
  renamePairWindowMs: number;
  massDeleteWindowMs: number;
  massDeleteThreshold: number;
}

export const DEFAULT_TIMING: SyncTiming = {
  diskWriteDebounceMs: DISK_WRITE_DEBOUNCE_MS,
  indexPassDebounceMs: INDEX_PASS_DEBOUNCE_MS,
  renamePairWindowMs: RENAME_PAIR_WINDOW_MS,
  massDeleteWindowMs: MASS_DELETE_WINDOW_MS,
  massDeleteThreshold: MASS_DELETE_THRESHOLD,
};

export interface SyncEngineDeps {
  vaultId: string;
  vault: VaultPort;
  storage: StoragePort;
  syncer: DocSyncer;
  persistence: DocPersistence;
  isOpenInEditor?: (path: string) => boolean;
  excludedPrefixes?: readonly string[];
  now?: () => number;
  notify?: (notice: SyncNotice) => void;
  timing?: Partial<SyncTiming>;
}

export class EngineStoppedError extends Error {
  constructor() {
    super("sync engine stopped");
    this.name = "EngineStoppedError";
  }
}

interface Wiring {
  records: RecordStore;
  docs: DocManager;
  index: VaultIndex;
  indexSync: DocSyncHandle;
  indexPersisted: PersistedDoc;
  indexDoc: Y.Doc;
  reconciler: FileReconciler;
  local: LocalChangeHandler;
  applier: IndexApplier;
  echoes: EchoTrackingVault;
  scan: StartupScan;
}

export class SyncEngine {
  private readonly timing: SyncTiming;
  private readonly now: () => number;
  private readonly notify: (notice: SyncNotice) => void;
  private readonly isOpenInEditor: (path: string) => boolean;
  private readonly queue = new SerialQueue((error) => this.reportFailure(error));
  private readonly debouncer = new KeyedDebouncer();
  private readonly disposers: Array<() => void> = [];
  private wiring: Wiring | null = null;
  private stopped = false;
  private signalStopped: () => void = () => {};
  private readonly stoppedSignal = new Promise<void>((resolve) => {
    this.signalStopped = resolve;
  });

  constructor(private readonly deps: SyncEngineDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.notify = deps.notify ?? (() => {});
    this.isOpenInEditor = deps.isOpenInEditor ?? (() => false);
  }

  async start(): Promise<void> {
    const wiring = await this.wire();
    if (!(await this.deps.storage.getFlag(BOOTSTRAP_FLAG))) await this.waitForFirstSync(wiring.indexSync);
    this.disposers.push(wiring.index.onRemoteChange(() => this.scheduleIndexPass()));
    this.disposers.push(this.deps.vault.onEvent((event) => this.route(event)));
    await this.enqueue((ready) => ready.scan.run());
    this.scheduleDeleteCommit();
    if (this.stopped) throw new EngineStoppedError();
    await this.deps.storage.setFlag(BOOTSTRAP_FLAG, true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.signalStopped();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.debouncer.cancelAll();
    await this.queue.enqueue(async () => {}); // queued tasks are skipped now; wait for the running one to finish
    const wiring = this.wiring;
    this.wiring = null;
    if (!wiring) return;
    await wiring.docs.closeAll();
    wiring.indexSync.destroy();
    wiring.indexPersisted.destroy();
    wiring.indexDoc.destroy();
  }

  /** Resolves when no timers are pending and the queue is empty. Used by tests and shutdown. */
  async idle(): Promise<void> {
    const quiet = () => this.debouncer.size === 0 && this.queue.isIdle;
    do {
      await waitUntil(quiet);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (!quiet());
  }

  confirmPausedDeletes(): Promise<void> {
    return this.enqueue((wiring) => wiring.local.confirmPausedDeletes());
  }

  restorePausedDeletes(): Promise<void> {
    return this.enqueue((wiring) => wiring.local.restorePausedDeletes());
  }

  /** Resolves wiring when the task runs, and skips the task once the engine has stopped. */
  private enqueue(task: (wiring: Wiring) => Promise<void>): Promise<void> {
    return this.queue.enqueue(async () => {
      if (this.stopped || !this.wiring) return;
      await task(this.wiring);
    });
  }

  private async wire(): Promise<Wiring> {
    const { vaultId, storage, syncer, persistence } = this.deps;
    const echoes = new EchoTrackingVault(this.deps.vault);
    const vault = echoes;
    const records = await RecordStore.load(storage);
    const docs = new DocManager({ vaultId, syncer, persistence, onTextChanged: (id) => this.scheduleTextFlush(id) });
    const indexDoc = new Y.Doc();
    const indexName = buildIndexDocName(vaultId);
    const indexPersisted = await persistence.attach(indexName, indexDoc);
    const indexSync = syncer.connect(indexName, indexDoc);
    const index = new VaultIndex(indexDoc);
    const isEligible = (path: string) => isSyncablePath(path, this.deps.excludedPrefixes);
    const reconciler = new FileReconciler({ vault, records, docs, now: this.now, notify: this.notify, requestRetry: (id) => this.scheduleTextFlush(id) });
    const guard = new MassDeleteGuard({ threshold: this.timing.massDeleteThreshold, windowMs: this.timing.massDeleteWindowMs, now: this.now });
    const local = new LocalChangeHandler({ vault, index, records, docs, reconciler, guard, now: this.now, notify: this.notify, isEligible, isOpenInEditor: this.isOpenInEditor });
    const applier = new IndexApplier({ vault, index, records, docs, reconciler, isEligible, requestPass: () => this.scheduleIndexPass() });
    const scan = new StartupScan({ vault, records, reconciler, local, applier, isEligible, notify: this.notify });
    this.wiring = { records, docs, index, indexSync, indexPersisted, indexDoc, reconciler, local, applier, echoes, scan };
    return this.wiring;
  }

  private async waitForFirstSync(indexSync: DocSyncHandle): Promise<void> {
    if (!indexSync.isSynced()) this.notify({ kind: "waiting-for-first-sync" });
    await Promise.race([indexSync.whenSynced(), this.stoppedSignal]);
    if (this.stopped) throw new EngineStoppedError();
  }

  private route(event: VaultEvent): void {
    if (this.stopped || this.requireWiring().echoes.consume(event)) return;
    const path = normalizeVaultPath(event.path);
    switch (event.type) {
      case "create":
        void this.enqueue(({ local }) => local.handleCreate(path));
        return;
      case "modify":
        void this.enqueue(({ local }) => local.handleModify(path));
        return;
      case "rename":
        // A move into an excluded folder becomes a pending delete, so the commit must be scheduled here too.
        void this.enqueue(({ local }) => local.handleRename(normalizeVaultPath(event.oldPath), path));
        this.scheduleDeleteCommit();
        return;
      case "delete":
        void this.enqueue(async ({ local }) => local.handleDelete(path));
        this.scheduleDeleteCommit();
        return;
    }
  }

  private scheduleDeleteCommit(): void {
    if (this.stopped) return;
    this.debouncer.schedule("deletes", this.timing.renamePairWindowMs, () => {
      void this.enqueue(({ local }) => local.commitPendingDeletes());
    });
  }

  private scheduleTextFlush(fileId: string): void {
    if (this.stopped) return;
    this.debouncer.schedule(`text:${fileId}`, this.timing.diskWriteDebounceMs, () => {
      void this.enqueue((wiring) => this.flushRemoteText(wiring, fileId));
    });
  }

  private async flushRemoteText(wiring: Wiring, fileId: string): Promise<void> {
    const record = wiring.records.get(fileId);
    if (!record || this.isOpenInEditor(record.path)) return; // the editor binding owns open files (spec §4.1)
    await wiring.reconciler.reconcile(fileId);
  }

  private scheduleIndexPass(): void {
    if (this.stopped) return;
    this.debouncer.schedule("index", this.timing.indexPassDebounceMs, () => {
      void this.enqueue(({ applier }) => applier.apply());
    });
  }

  private requireWiring(): Wiring {
    if (!this.wiring) throw new EngineStoppedError();
    return this.wiring;
  }

  /** Queue boundary: one failed task must not stop syncing other files. */
  private reportFailure(error: unknown): void {
    if (this.stopped) return;
    this.notify({ kind: "task-failed", message: error instanceof Error ? error.message : String(error) });
  }
}
