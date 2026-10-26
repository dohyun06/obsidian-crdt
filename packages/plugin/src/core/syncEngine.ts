import {
  DISK_WRITE_DEBOUNCE_MS,
  EDITOR_SNAPSHOT_DEBOUNCE_MS,
  INDEX_PASS_DEBOUNCE_MS,
  MASS_DELETE_THRESHOLD,
  MASS_DELETE_WINDOW_MS,
  normalizeVaultPath,
  RENAME_PAIR_WINDOW_MS,
} from "@obsidian-crdt/shared";
import { type DebugLog, type EditorDoc, EditorAccess } from "./editorAccess";
import { createWiring, type Wiring } from "./engineWiring";
import type { SyncNotice } from "./notices";
import type { DocPersistence, DocSyncer, DocSyncHandle, StoragePort, VaultEvent, VaultPort } from "./ports";
import { KeyedDebouncer, SerialQueue, waitUntil } from "./scheduling";

export type { DebugLog, EditorDoc } from "./editorAccess";

export const BOOTSTRAP_FLAG = "bootstrapped";

export interface SyncTiming {
  diskWriteDebounceMs: number;
  indexPassDebounceMs: number;
  renamePairWindowMs: number;
  massDeleteWindowMs: number;
  massDeleteThreshold: number;
  editorSnapshotDebounceMs: number;
}

export const DEFAULT_TIMING: SyncTiming = {
  diskWriteDebounceMs: DISK_WRITE_DEBOUNCE_MS,
  indexPassDebounceMs: INDEX_PASS_DEBOUNCE_MS,
  renamePairWindowMs: RENAME_PAIR_WINDOW_MS,
  massDeleteWindowMs: MASS_DELETE_WINDOW_MS,
  massDeleteThreshold: MASS_DELETE_THRESHOLD,
  editorSnapshotDebounceMs: EDITOR_SNAPSHOT_DEBOUNCE_MS,
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
  /** Content-free diagnostics (event kinds, paths, fileIds); never note text or tokens. */
  debug?: DebugLog;
}

export class EngineStoppedError extends Error {
  constructor() {
    super("sync engine stopped");
    this.name = "EngineStoppedError";
  }
}

export class SyncEngine {
  private readonly timing: SyncTiming;
  private readonly now: () => number;
  private readonly notify: (notice: SyncNotice) => void;
  private readonly debug: DebugLog;
  private readonly editors: EditorAccess;
  private readonly queue = new SerialQueue((error) => this.reportFailure(error));
  private readonly debouncer = new KeyedDebouncer();
  private readonly disposers: Array<() => void> = [];
  private wiring: Wiring | null = null;
  private releasing: Promise<void> = Promise.resolve();
  private stopped = false;
  private signalStopped: () => void = () => {};
  private readonly stoppedSignal = new Promise<void>((resolve) => {
    this.signalStopped = resolve;
  });

  constructor(private readonly deps: SyncEngineDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.notify = deps.notify ?? (() => {});
    this.debug = deps.debug ?? (() => {});
    this.editors = new EditorAccess({
      isPathOpen: deps.isOpenInEditor ?? (() => false),
      wiring: () => this.wiring,
      enqueue: (task) => this.enqueue(task),
      flushRemoteText: (wiring, fileId) => this.flushRemoteText(wiring, fileId),
      debouncer: this.debouncer,
      snapshotDebounceMs: this.timing.editorSnapshotDebounceMs,
      isStopped: () => this.stopped,
      debug: this.debug,
    });
  }

  async start(): Promise<void> {
    const wiring = await this.wire();
    await this.abortIfStopped(); // stop() may have run while wire() was loading and found nothing to tear down
    if (!(await this.deps.storage.getFlag(BOOTSTRAP_FLAG))) await this.waitForFirstSync(wiring.indexSync);
    await this.abortIfStopped(); // stop() already removed the listeners; registering them now would leak them
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
    await this.teardown();
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

  /** Called by the editor binding when a bound editor closes (see EditorAccess). */
  notifyEditorClosed(path: string, fileId?: string): void {
    this.editors.notifyEditorClosed(path, fileId);
  }

  /**
   * The shared Y.Text for a tracked file; `editorText` (what the editor shows) is merged in first, against
   * `previousEditorText` when an earlier request of the same bind already merged that text.
   */
  openDocForPath(path: string, editorText?: string, previousEditorText?: string): Promise<EditorDoc | null> {
    return this.editors.openDocForPath(path, editorText, previousEditorText);
  }

  /** Remember the current Y.Text of an open file right before the editor saves it (spec §9 close order). */
  captureEditorSnapshot(path: string, fileId?: string): void {
    this.editors.captureEditorSnapshot(path, fileId);
  }

  private onTextChanged(fileId: string): void {
    this.scheduleTextFlush(fileId);
    this.editors.onTextChanged(fileId);
  }

  /** Resolves wiring when the task runs, and skips the task once the engine has stopped. */
  private enqueue(task: (wiring: Wiring) => Promise<void>): Promise<void> {
    return this.queue.enqueue(async () => {
      if (this.stopped || !this.wiring) return;
      await task(this.wiring);
    });
  }

  private async wire(): Promise<Wiring> {
    this.wiring = await createWiring(this.deps, {
      now: this.now,
      notify: this.notify,
      isOpenInEditor: (fileId, path) => this.editors.isOpen(fileId, path),
      massDelete: { threshold: this.timing.massDeleteThreshold, windowMs: this.timing.massDeleteWindowMs },
      onTextChanged: (id) => this.onTextChanged(id),
      requestRetry: (id) => this.scheduleTextFlush(id),
      requestPass: () => this.scheduleIndexPass(),
    });
    return this.wiring;
  }

  /**
   * Idempotent: whichever of stop() and an interrupted start() gets here first releases the wiring;
   * the other waits for that release instead of returning early.
   */
  private async teardown(): Promise<void> {
    const wiring = this.wiring;
    this.wiring = null;
    if (wiring) this.releasing = releaseWiring(wiring);
    await this.releasing;
  }

  private async abortIfStopped(): Promise<void> {
    if (!this.stopped) return;
    await this.teardown();
    throw new EngineStoppedError();
  }

  private async waitForFirstSync(indexSync: DocSyncHandle): Promise<void> {
    if (!indexSync.isSynced()) this.notify({ kind: "waiting-for-first-sync" });
    await Promise.race([indexSync.whenSynced(), this.stoppedSignal]);
    if (this.stopped) throw new EngineStoppedError();
  }

  private route(event: VaultEvent): void {
    if (this.stopped) return;
    const normalized = normalizeEvent(event);
    if (this.requireWiring().echoes.consume(normalized)) return this.debug("echo-consumed", eventFields(normalized));
    this.debug("vault-event", eventFields(normalized));
    const path = normalized.path;
    switch (normalized.type) {
      case "create":
        void this.enqueue(({ local }) => local.handleCreate(path));
        return;
      case "modify":
        void this.enqueue(({ local }) => local.handleModify(path));
        return;
      case "rename":
        // A move into an excluded folder becomes a pending delete, so the commit must be scheduled here too.
        void this.enqueue(({ local }) => local.handleRename(normalized.oldPath, path));
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
    if (!record || this.editors.isOpen(fileId, record.path)) return; // the editor binding owns open files (spec §4.1)
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

async function releaseWiring(wiring: Wiring): Promise<void> {
  await wiring.docs.closeAll();
  wiring.indexSync.destroy();
  wiring.indexPersisted.destroy();
  wiring.indexDoc.destroy();
}

function normalizeEvent(event: VaultEvent): VaultEvent {
  if (event.type === "rename") return { ...event, oldPath: normalizeVaultPath(event.oldPath), path: normalizeVaultPath(event.path) };
  return { ...event, path: normalizeVaultPath(event.path) };
}

function eventFields(event: VaultEvent): Record<string, string> {
  return event.type === "rename" ? { kind: event.type, oldPath: event.oldPath, path: event.path } : { kind: event.type, path: event.path };
}
