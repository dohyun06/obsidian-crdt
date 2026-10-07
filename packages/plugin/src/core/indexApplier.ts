import type { DocManager } from "./docManager";
import type { FileReconciler } from "./fileReconciler";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";
import type { IndexEntry, VaultIndex } from "./vaultIndex";

export interface IndexApplierDeps {
  vault: VaultPort;
  index: VaultIndex;
  records: RecordStore;
  docs: DocManager;
  reconciler: FileReconciler;
  isEligible: (path: string) => boolean;
  /** Called when a document that was not yet synced becomes synced, so another pass can create it. */
  requestPass: () => void;
}

/** Makes this device's disk match the index: deletions, then moves, then creations (spec §4.4). */
export class IndexApplier {
  constructor(private readonly deps: IndexApplierDeps) {}

  async apply(): Promise<void> {
    const plan = this.deps.index.planCollisionResolution();
    if (plan.length > 0) this.deps.index.applyReassignments(plan);
    const entries = this.deps.index.entries();
    for (const entry of entries) if (entry.deleted) await this.applyDeletion(entry);
    for (const entry of entries) if (!entry.deleted) await this.applyMove(entry);
    for (const entry of entries) if (!entry.deleted) await this.applyCreation(entry);
  }

  private async applyDeletion(entry: IndexEntry): Promise<void> {
    const record = this.deps.records.get(entry.fileId);
    if (!record) return;
    await this.deps.records.delete(entry.fileId); // first, so the resulting delete event is ignored
    if ((await this.deps.vault.read(record.path)) !== null) await this.deps.vault.trash(record.path);
  }

  private async applyMove(entry: IndexEntry): Promise<void> {
    const record = this.deps.records.get(entry.fileId);
    if (!record || record.path === entry.path) return;
    if (!this.deps.isEligible(entry.path)) return;
    if ((await this.deps.vault.read(entry.path)) !== null) return; // target busy; a later pass retries
    const sourceExists = (await this.deps.vault.read(record.path)) !== null;
    await this.deps.records.set(entry.fileId, { path: entry.path, base: record.base });
    if (sourceExists) await this.deps.vault.rename(record.path, entry.path);
  }

  private async applyCreation(entry: IndexEntry): Promise<void> {
    if (this.deps.records.get(entry.fileId) || !this.deps.isEligible(entry.path)) return;
    if (this.deps.records.findIdByPath(entry.path)) return; // another file still sits there; wait for its move
    const opened = await this.deps.docs.open(entry.fileId);
    if (!opened.sync.isSynced()) {
      void opened.sync.whenSynced().then(this.deps.requestPass);
      return;
    }
    if ((await this.deps.vault.read(entry.path)) !== null) return this.adoptExisting(entry);
    const text = opened.text.toString();
    await this.deps.records.set(entry.fileId, { path: entry.path, base: text });
    if (!(await this.deps.vault.replace(entry.path, null, text))) await this.adoptExisting(entry);
  }

  /** An untracked local file already uses the path: server text wins, the local text is kept as a copy. */
  private async adoptExisting(entry: IndexEntry): Promise<void> {
    await this.deps.records.set(entry.fileId, { path: entry.path, base: null });
    await this.deps.reconciler.reconcile(entry.fileId);
  }
}
