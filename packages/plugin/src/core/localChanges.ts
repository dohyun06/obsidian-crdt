import { isWithinSizeLimit } from "@obsidian-crdt/shared";
import { DISK_ORIGIN, type DocManager } from "./docManager";
import type { FileReconciler } from "./fileReconciler";
import type { MassDeleteGuard } from "./massDeleteGuard";
import type { SyncNotice } from "./notices";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";
import { applyMinimalDiff } from "./textDiff";
import type { VaultIndex } from "./vaultIndex";

export interface LocalChangeDeps {
  vault: VaultPort;
  index: VaultIndex;
  records: RecordStore;
  docs: DocManager;
  reconciler: FileReconciler;
  guard: MassDeleteGuard;
  now: () => number;
  notify: (notice: SyncNotice) => void;
  isEligible: (path: string) => boolean;
  isOpenInEditor: (path: string) => boolean;
}

interface PendingDelete {
  fileId: string;
  path: string;
  base: string | null;
}

/** Turns this device's vault events into index and document changes (spec §4.4). */
export class LocalChangeHandler {
  private readonly pendingDeletes = new Map<string, PendingDelete>();
  private pausedDeletes: PendingDelete[] = [];

  constructor(private readonly deps: LocalChangeDeps) {}

  async handleCreate(path: string): Promise<void> {
    if (!this.deps.isEligible(path)) return;
    const knownId = this.deps.records.findIdByPath(path);
    if (knownId) return this.deps.reconciler.reconcile(knownId);
    const live = this.deps.index.findLiveByPath(path);
    // A live entry this device still tracks at another path is a remote move the index pass has not applied yet.
    // Taking it over would orphan the file at the old path; instead this file is registered as its own entry and
    // the same-path rule (spec §4.4) settles the collision on every device.
    if (live && !this.deps.records.get(live.fileId)) return this.adoptRemoteEntry(live.fileId, path);
    const text = await this.deps.vault.read(path);
    if (text === null) return;
    if (!isWithinSizeLimit(text)) return this.deps.notify({ kind: "file-too-large", path });
    const renamed = this.takePendingDeleteWithBase(text);
    if (renamed) return this.moveTracked(renamed.fileId, path);
    await this.registerNew(path, text);
  }

  async handleModify(path: string): Promise<void> {
    if (!this.deps.isEligible(path)) return;
    const fileId = this.deps.records.findIdByPath(path);
    if (this.deps.isOpenInEditor(path)) {
      // The editor owns open files (spec §4.1); only an autosave that matches the Y.Text is taken, as the new base.
      if (fileId) await this.deps.reconciler.acceptEditorSave(fileId);
      return;
    }
    if (fileId) return this.deps.reconciler.reconcile(fileId);
    return this.handleCreate(path);
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const fileId = this.deps.records.findIdByPath(oldPath);
    if (!fileId) return this.handleCreate(newPath);
    if (!this.deps.isEligible(newPath)) return this.handleDelete(oldPath);
    await this.moveTracked(fileId, newPath);
  }

  /** Deletes wait for the rename-pair window; the engine then calls commitPendingDeletes(). */
  handleDelete(path: string): void {
    const fileId = this.deps.records.findIdByPath(path);
    if (!fileId || this.pendingDeletes.has(fileId)) return;
    this.pendingDeletes.set(fileId, { fileId, path, base: this.deps.records.get(fileId)?.base ?? null });
  }

  async commitPendingDeletes(): Promise<void> {
    const batch = [...this.pendingDeletes.values()];
    this.pendingDeletes.clear();
    if (batch.length === 0) return;
    if (this.pausedDeletes.length > 0 || this.deps.guard.record(batch.length)) {
      this.pausedDeletes.push(...batch);
      this.deps.notify({ kind: "mass-delete-paused", paths: this.pausedDeletes.map((item) => item.path) });
      return;
    }
    for (const item of batch) await this.commitDelete(item);
  }

  async confirmPausedDeletes(): Promise<void> {
    const paused = this.takePaused();
    for (const item of paused) await this.commitDelete(item);
  }

  async restorePausedDeletes(): Promise<void> {
    const paused = this.takePaused();
    for (const item of paused) {
      const { text } = await this.deps.docs.open(item.fileId);
      await this.deps.vault.replace(item.path, null, text.toString());
    }
  }

  private takePaused(): PendingDelete[] {
    const paused = this.pausedDeletes;
    this.pausedDeletes = [];
    this.deps.guard.reset();
    return paused;
  }

  private async commitDelete(item: PendingDelete): Promise<void> {
    if ((await this.deps.vault.read(item.path)) !== null) return; // the file came back
    this.deps.index.markDeleted(item.fileId);
    await this.deps.records.delete(item.fileId);
  }

  private async adoptRemoteEntry(fileId: string, path: string): Promise<void> {
    await this.deps.records.set(fileId, { path, base: null });
    await this.deps.reconciler.reconcile(fileId);
  }

  private async moveTracked(fileId: string, newPath: string): Promise<void> {
    const record = this.deps.records.get(fileId);
    this.deps.index.rename(fileId, newPath);
    await this.deps.records.set(fileId, { path: newPath, base: record?.base ?? null });
    await this.deps.reconciler.reconcile(fileId);
  }

  private async registerNew(path: string, text: string): Promise<void> {
    const fileId = this.deps.index.register(path, this.deps.now());
    const opened = await this.deps.docs.open(fileId);
    applyMinimalDiff(opened.text, text, DISK_ORIGIN);
    await this.deps.records.set(fileId, { path, base: text });
  }

  /** Empty files are never paired: any two empty notes would look like a rename. */
  private takePendingDeleteWithBase(text: string): PendingDelete | null {
    if (text === "") return null;
    for (const item of this.pendingDeletes.values()) {
      if (item.base === text) {
        this.pendingDeletes.delete(item.fileId);
        return item;
      }
    }
    return null;
  }
}
