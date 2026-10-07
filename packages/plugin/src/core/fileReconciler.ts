import { buildConflictPath, withCounter } from "./conflictPath";
import { DISK_ORIGIN, type DocManager, type OpenedDoc } from "./docManager";
import type { SyncNotice } from "./notices";
import type { VaultPort } from "./ports";
import { decideDiskReconcile, type ReconcileDecision } from "./reconcileDecision";
import type { RecordStore } from "./recordStore";
import { applyMinimalDiff } from "./textDiff";

export interface FileReconcilerDeps {
  vault: VaultPort;
  records: RecordStore;
  docs: DocManager;
  now: () => number;
  notify: (notice: SyncNotice) => void;
  requestRetry: (fileId: string) => void;
}

const FIRST_COUNTER = 2;

export async function findFreePath(vault: VaultPort, candidate: string): Promise<string> {
  if ((await vault.read(candidate)) === null) return candidate;
  for (let counter = FIRST_COUNTER; ; counter++) {
    const next = withCounter(candidate, counter);
    if ((await vault.read(next)) === null) return next;
  }
}

/** Brings one file's disk text and Y.Text together (spec §4.3). */
export class FileReconciler {
  constructor(private readonly deps: FileReconcilerDeps) {}

  async reconcile(fileId: string): Promise<void> {
    const record = this.deps.records.get(fileId);
    if (!record) return;
    const opened = await this.deps.docs.open(fileId);
    // Without a base, the local doc may still be empty; seeding it from disk would double the text (spec §4.5).
    if (record.base === null) await opened.sync.whenSynced();
    const disk = await this.deps.vault.read(record.path);
    if (disk === null) return; // missing files are handled by the delete flow
    const decision = decideDiskReconcile({ base: record.base, disk, current: opened.text.toString() });
    const settled = await this.apply({ fileId, path: record.path, opened, disk }, decision);
    if (!settled) this.deps.requestRetry(fileId);
  }

  private async apply(target: Target, decision: ReconcileDecision): Promise<boolean> {
    switch (decision.kind) {
      case "in-sync":
        await this.saveBase(target, target.disk);
        return true;
      case "write-disk":
        return this.writeAndSave(target, decision.text);
      case "merge":
        applyMinimalDiff(target.opened.text, decision.text, DISK_ORIGIN);
        return this.writeAndSave(target, decision.text);
      case "conflict":
        await this.saveDiskCopy(target, decision.diskCopy);
        return this.writeAndSave(target, decision.keep);
    }
  }

  private async writeAndSave(target: Target, next: string): Promise<boolean> {
    if (next !== target.disk && !(await this.deps.vault.replace(target.path, target.disk, next))) return false;
    await this.saveBase(target, next);
    return true;
  }

  private saveBase(target: Target, base: string): Promise<void> {
    return this.deps.records.set(target.fileId, { path: target.path, base });
  }

  private async saveDiskCopy(target: Target, text: string): Promise<void> {
    const candidate = buildConflictPath({ path: target.path, label: "conflict-disk", timestampMs: this.deps.now(), fileId: target.fileId });
    const copyPath = await findFreePath(this.deps.vault, candidate);
    await this.deps.vault.replace(copyPath, null, text);
    this.deps.notify({ kind: "conflict-copy", path: target.path, copyPath });
  }
}

interface Target {
  fileId: string;
  path: string;
  opened: OpenedDoc;
  disk: string;
}
