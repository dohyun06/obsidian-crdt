import { normalizeVaultPath } from "@obsidian-crdt/shared";
import type { FileReconciler } from "./fileReconciler";
import type { IndexApplier } from "./indexApplier";
import type { LocalChangeHandler } from "./localChanges";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";

export interface StartupScanDeps {
  vault: VaultPort;
  records: RecordStore;
  reconciler: FileReconciler;
  local: LocalChangeHandler;
  applier: IndexApplier;
  isEligible: (path: string) => boolean;
}

/** Catches up with everything that happened while the plugin was not running (spec §4.3, §4.5). */
export class StartupScan {
  constructor(private readonly deps: StartupScanDeps) {}

  async run(): Promise<void> {
    const diskPaths = (await this.deps.vault.listFiles()).map(normalizeVaultPath).filter(this.deps.isEligible);
    const onDisk = new Set(diskPaths);
    for (const [, record] of this.deps.records.entries()) {
      if (!onDisk.has(record.path)) this.deps.local.handleDelete(record.path);
    }
    for (const path of diskPaths) {
      const fileId = this.deps.records.findIdByPath(path);
      if (fileId) await this.deps.reconciler.reconcile(fileId);
      else await this.deps.local.handleCreate(path);
    }
    await this.deps.applier.apply();
  }
}
