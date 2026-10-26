import { foldPathCase, normalizeVaultPath } from "@obsidian-crdt/shared";
import type { DocManager } from "./docManager";
import type { FileReconciler } from "./fileReconciler";
import type { VaultPort } from "./ports";
import type { FileRecord } from "./ports";
import type { RecordStore } from "./recordStore";
import type { IndexEntry, VaultIndex } from "./vaultIndex";

export interface IndexApplierDeps {
  vault: VaultPort;
  index: VaultIndex;
  records: RecordStore;
  docs: DocManager;
  reconciler: FileReconciler;
  isEligible: (path: string) => boolean;
  /** Called when more work is possible (a document became synced, a move was unblocked), so another pass runs. */
  requestPass: () => void;
}

type MoveOutcome = "moved" | "deferred" | "none";

/** Makes this device's disk match the index: deletions, then moves, then creations (spec §4.4). */
export class IndexApplier {
  private readonly awaitingSync = new Set<string>();

  constructor(private readonly deps: IndexApplierDeps) {}

  async apply(): Promise<void> {
    const plan = this.deps.index.planCollisionResolution();
    if (plan.length > 0) this.deps.index.applyReassignments(plan);
    const entries = this.deps.index.entries();
    for (const entry of entries) if (entry.deleted) await this.applyDeletion(entry);
    await this.applyMoves(entries.filter((entry) => !entry.deleted));
    for (const entry of entries) if (!entry.deleted) await this.applyCreation(entry);
  }

  private async applyDeletion(entry: IndexEntry): Promise<void> {
    const record = this.deps.records.get(entry.fileId);
    if (!record) return;
    await this.deps.records.delete(entry.fileId); // first, so the resulting delete event is ignored
    if ((await this.deps.vault.read(record.path)) !== null) await this.deps.vault.trash(record.path);
  }

  /** Moves into busy targets wait for the occupant to leave; a cycle (swap) is broken via a temporary name. */
  private async applyMoves(entries: IndexEntry[]): Promise<void> {
    const deferred: IndexEntry[] = [];
    let moved = false;
    for (const entry of entries) {
      const outcome = await this.applyMove(entry);
      if (outcome === "moved") moved = true;
      if (outcome === "deferred") deferred.push(entry);
    }
    if (deferred.length === 0) return;
    if (moved) return this.deps.requestPass();
    const blocked = deferred.find((entry) => this.occupantMustMove(entry));
    if (blocked) await this.moveAside(blocked);
  }

  private async applyMove(entry: IndexEntry): Promise<MoveOutcome> {
    const record = this.deps.records.get(entry.fileId);
    if (!record || record.path === entry.path) return "none";
    if (!this.deps.isEligible(entry.path)) return "none";
    if (await this.isTargetBusy(record.path, entry.path)) return "deferred"; // a later pass retries
    await this.moveRecordAndFile(entry.fileId, record, entry.path);
    return "moved";
  }

  /**
   * On a case-insensitive file system (APFS) a case-only move finds its own file at the target; that is not busy.
   * There only the source spelling is listed, so the target is busy only when its exact spelling is listed: a
   * different file on a case-sensitive file system (Linux, Android).
   */
  private async isTargetBusy(sourcePath: string, targetPath: string): Promise<boolean> {
    if (foldPathCase(targetPath) !== foldPathCase(sourcePath)) return (await this.deps.vault.read(targetPath)) !== null;
    return (await this.deps.vault.listFiles()).map(normalizeVaultPath).includes(targetPath);
  }

  /** The record moves first, so the resulting rename event is ignored; a failed rename restores it. */
  private async moveRecordAndFile(fileId: string, record: FileRecord, targetPath: string): Promise<void> {
    const sourceExists = (await this.deps.vault.read(record.path)) !== null;
    await this.deps.records.set(fileId, { path: targetPath, base: record.base });
    if (!sourceExists) return;
    try {
      await this.deps.vault.rename(record.path, targetPath);
    } catch (error) {
      await this.deps.records.set(fileId, record); // never leave the record pointing at a file that is not this one
      throw error;
    }
  }

  private occupantMustMove(entry: IndexEntry): boolean {
    const occupantId = this.deps.records.findIdByPath(entry.path);
    if (!occupantId) return false;
    const occupantTarget = this.deps.index.get(occupantId);
    return occupantTarget !== null && !occupantTarget.deleted && occupantTarget.path !== entry.path;
  }

  private async moveAside(entry: IndexEntry): Promise<void> {
    const record = this.deps.records.get(entry.fileId);
    if (!record) return;
    const temporary = temporaryMovePath(record.path, entry.fileId);
    if ((await this.deps.vault.read(temporary)) !== null) return;
    await this.moveRecordAndFile(entry.fileId, record, temporary);
    this.deps.requestPass();
  }

  private async applyCreation(entry: IndexEntry): Promise<void> {
    if (this.deps.records.get(entry.fileId) || !this.deps.isEligible(entry.path)) return;
    if (this.deps.records.findIdByPath(entry.path)) return; // another file still sits there; wait for its move
    const opened = await this.deps.docs.open(entry.fileId);
    if (!opened.sync.isSynced()) {
      this.passWhenSynced(entry.fileId, opened.sync.whenSynced());
      return;
    }
    if ((await this.deps.vault.read(entry.path)) !== null) return this.adoptExisting(entry);
    const text = opened.text.toString();
    await this.deps.records.set(entry.fileId, { path: entry.path, base: text });
    if (!(await this.deps.vault.replace(entry.path, null, text))) await this.adoptExisting(entry);
  }

  private passWhenSynced(fileId: string, synced: Promise<void>): void {
    if (this.awaitingSync.has(fileId)) return;
    this.awaitingSync.add(fileId);
    void synced.then(() => {
      this.awaitingSync.delete(fileId);
      this.deps.requestPass();
    });
  }

  /** An untracked local file already uses the path: server text wins, the local text is kept as a copy. */
  private async adoptExisting(entry: IndexEntry): Promise<void> {
    await this.deps.records.set(entry.fileId, { path: entry.path, base: null });
    await this.deps.reconciler.reconcile(entry.fileId);
  }
}

function temporaryMovePath(path: string, fileId: string): string {
  const dot = path.lastIndexOf(".");
  const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
  return `${stem}.crdt-move-${fileId.slice(0, 6)}.md`;
}
