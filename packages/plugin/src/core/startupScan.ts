import { normalizeVaultPath } from "@obsidian-crdt/shared";
import type { FileReconciler } from "./fileReconciler";
import type { IndexApplier } from "./indexApplier";
import type { LocalChangeHandler } from "./localChanges";
import type { SyncNotice } from "./notices";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";

export interface StartupScanDeps {
  vault: VaultPort;
  records: RecordStore;
  reconciler: FileReconciler;
  local: LocalChangeHandler;
  applier: IndexApplier;
  isEligible: (path: string) => boolean;
  notify: (notice: SyncNotice) => void;
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
    for (const path of diskPaths) await this.scanPath(path);
    await this.guarded(() => this.deps.applier.apply());
  }

  private scanPath(path: string): Promise<void> {
    return this.guarded(async () => {
      const fileId = this.deps.records.findIdByPath(path);
      if (fileId) await this.deps.reconciler.reconcile(fileId);
      else await this.deps.local.handleCreate(path);
    });
  }

  /** Boundary: one failing file must not stop the scan for the others. */
  private async guarded(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.deps.notify({ kind: "task-failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
}
