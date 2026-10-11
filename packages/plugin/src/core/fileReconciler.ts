import { isWithinSizeLimit } from "@obsidian-crdt/shared";
import { buildConflictPath, withCounter } from "./conflictPath";
import { DISK_ORIGIN, type DocManager, type OpenedDoc } from "./docManager";
import type { SyncNotice } from "./notices";
import type { VaultPort } from "./ports";
import { decideDiskReconcile, type ReconcileDecision } from "./reconcileDecision";
import type { RecordStore } from "./recordStore";
import { applyMinimalDiff } from "./textDiff";
import type { TextHistory } from "./textHistory";

export interface FileReconcilerDeps {
  vault: VaultPort;
  records: RecordStore;
  docs: DocManager;
  now: () => number;
  history: TextHistory;
  notify: (notice: SyncNotice) => void;
  requestRetry: (fileId: string) => void;
}

const FIRST_COUNTER = 2;
/** Origin of editor text merged at bind time; unlike DISK_ORIGIN it is not on disk yet, so it counts as a text change. */
const EDITOR_TEXT_ORIGIN = Symbol("editor-text");

/** How many files remember the disk text the engine last replaced (see absorbEditorText). */
export const REPLACED_DISK_TEXTS_LIMIT = 64;

export type AbsorbOutcome = ReconcileDecision["kind"] | "skipped";

export async function findFreePath(vault: VaultPort, candidate: string): Promise<string> {
  if ((await vault.read(candidate)) === null) return candidate;
  for (let counter = FIRST_COUNTER; ; counter++) {
    const next = withCounter(candidate, counter);
    if ((await vault.read(next)) === null) return next;
  }
}

/** Brings one file's disk text and Y.Text together (spec §4.3). */
export class FileReconciler {
  private readonly awaitingSync = new Set<string>();
  private readonly oversize = new Set<string>();
  /** fileId → the disk text this engine last overwrote; oldest entries are dropped first. */
  private readonly replacedDiskTexts = new Map<string, string>();

  constructor(private readonly deps: FileReconcilerDeps) {}

  async reconcile(fileId: string): Promise<void> {
    const record = this.deps.records.get(fileId);
    if (!record) return;
    const opened = await this.deps.docs.open(fileId);
    // Without a base, the local doc may still be empty; seeding it from disk would double the text (spec §4.5).
    // Never block the engine's serial queue while offline: retry once the server state has arrived.
    if (record.base === null && !opened.sync.isSynced()) {
      this.retryWhenSynced(fileId, opened);
      return;
    }
    const disk = await this.deps.vault.read(record.path);
    if (disk === null) return; // missing files are handled by the delete flow
    if (!this.fitsSizeLimit(fileId, record.path, disk)) return;
    const current = opened.text.toString();
    const decision = decideDiskReconcile({ base: this.baseFor(fileId, record.base, disk, current), disk, current });
    const settled = await this.apply({ fileId, path: record.path, opened, disk }, decision);
    if (!settled) this.deps.requestRetry(fileId);
  }

  /**
   * Text an editor showed before it was bound (typed while unbound, not saved yet) is treated like a disk text that
   * is not on disk yet. It is merged into the Y.Text like one (spec §4.3), but nothing is written to disk and the
   * base stays: the bound editor saves the result, and that save becomes the base (acceptEditorSave).
   * On a conflict the Y.Text is kept and the editor text is saved as a conflict-disk copy, so it is never lost.
   * `previousEditorText` (an editor text an earlier request of the same bind already merged) is the base then, so
   * only the delta typed since is merged. Every absorbed editor text is recorded in the TextHistory: it carries
   * nothing new any more, so a second pane showing the same text does not merge it twice (oversize texts excepted).
   * An editor that still shows the disk text this engine replaced while no editor was bound, plus typing, keeps the
   * Y.Text (the remote edit) and its text is saved as a conflict-disk copy. The remembered replaced text is consumed
   * by the first bind after the replace.
   */
  async absorbEditorText(fileId: string, editorText: string, previousEditorText?: string): Promise<AbsorbOutcome> {
    const record = this.deps.records.get(fileId);
    if (!record || record.base === null) return "skipped";
    const opened = await this.deps.docs.open(fileId);
    const target: Target = { fileId, path: record.path, opened, disk: editorText };
    const outcome = await this.absorbInto(target, record.base, previousEditorText);
    this.replacedDiskTexts.delete(fileId);
    // An oversize text never entered the Y.Text (it is only a copy): do not hold it in memory as a known state.
    if (isWithinSizeLimit(editorText)) this.deps.history.record(fileId, editorText);
    return outcome;
  }

  private async absorbInto(target: Target, recordBase: string, previousEditorText?: string): Promise<ReconcileDecision["kind"]> {
    const editorText = target.disk;
    if (!isWithinSizeLimit(editorText)) {
      await this.saveDiskCopy(target, editorText); // spec §5: never pushed into the Y.Text, but never dropped either
      return "conflict";
    }
    const current = target.opened.text.toString();
    if (this.isStaleEditorWithTyping(target.fileId, recordBase, editorText, current, previousEditorText)) {
      await this.saveDiskCopy(target, editorText); // merging against the new base would revert the remote edit
      return "conflict";
    }
    const base = this.absorbBase(target.fileId, recordBase, editorText, current, previousEditorText);
    const decision = decideDiskReconcile({ base, disk: editorText, current });
    if (decision.kind === "merge") applyMinimalDiff(target.opened.text, decision.text, EDITOR_TEXT_ORIGIN);
    if (decision.kind === "conflict") await this.saveDiskCopy(target, decision.diskCopy);
    return decision.kind;
  }

  /**
   * The editor was not reloaded after the engine replaced its disk text, and the user typed on the old text.
   * An editor showing the base (the replacing text) did reload: newer remote edits are merged normally then.
   */
  private isStaleEditorWithTyping(fileId: string, recordBase: string, editorText: string, current: string, previousEditorText?: string): boolean {
    const replaced = this.replacedDiskTexts.get(fileId);
    if (previousEditorText !== undefined || replaced === undefined || editorText === recordBase) return false;
    return editorText !== replaced && editorText !== current && !this.deps.history.has(fileId, editorText);
  }

  private absorbBase(fileId: string, recordBase: string, editorText: string, current: string, previousEditorText?: string): string | null {
    if (previousEditorText !== undefined) return previousEditorText;
    // An editor that has not reloaded yet still shows the disk text this engine just replaced: nothing new in it.
    if (editorText === this.replacedDiskTexts.get(fileId)) return editorText;
    return this.baseFor(fileId, recordBase, editorText, current);
  }

  /**
   * Spec §4.1: while a file is open in a bound editor, the disk is the editor's autosave. A save that has
   * caught up with the Y.Text (local typing or remote edits shown in the editor) becomes the new base, so the
   * next three-way merge after the editor closes does not apply those changes a second time. A save of a state the Y.Text recently
   * had (recorded in TextHistory) is accepted too; anything else is ignored.
   */
  async acceptEditorSave(fileId: string): Promise<void> {
    const record = this.deps.records.get(fileId);
    if (!record) return;
    const opened = await this.deps.docs.open(fileId);
    const disk = await this.deps.vault.read(record.path);
    if (disk === null || disk === record.base) return;
    if (disk !== opened.text.toString() && !this.deps.history.has(fileId, disk)) return;
    await this.deps.records.set(fileId, { path: record.path, base: disk });
  }

  /** A disk text the Y.Text already had (a lagging editor save) carries nothing new: it is the real base. */
  private baseFor(fileId: string, base: string | null, disk: string, current: string): string | null {
    return base !== null && disk !== current && this.deps.history.has(fileId, disk) ? disk : base;
  }

  private retryWhenSynced(fileId: string, opened: OpenedDoc): void {
    if (this.awaitingSync.has(fileId)) return;
    this.awaitingSync.add(fileId);
    void opened.sync.whenSynced().then(() => {
      this.awaitingSync.delete(fileId);
      this.deps.requestRetry(fileId);
    });
  }

  /** Spec §5: oversize disk text is never pushed into the Y.Text; one notice per oversize episode. */
  private fitsSizeLimit(fileId: string, path: string, disk: string): boolean {
    if (isWithinSizeLimit(disk)) {
      this.oversize.delete(fileId);
      return true;
    }
    if (!this.oversize.has(fileId)) {
      this.oversize.add(fileId);
      this.deps.notify({ kind: "file-too-large", path });
    }
    return false;
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
        // Base = the copied text, so a retry after a failed write is a normal merge, not another conflict.
        await this.saveBase(target, decision.diskCopy);
        return this.writeAndSave(target, decision.keep);
    }
  }

  private async writeAndSave(target: Target, next: string): Promise<boolean> {
    if (next !== target.disk) {
      if (!(await this.deps.vault.replace(target.path, target.disk, next))) return false;
      this.rememberReplaced(target.fileId, target.disk);
    }
    await this.saveBase(target, next);
    return true;
  }

  private rememberReplaced(fileId: string, text: string): void {
    this.replacedDiskTexts.delete(fileId);
    this.replacedDiskTexts.set(fileId, text);
    const oldest = this.replacedDiskTexts.keys().next();
    if (this.replacedDiskTexts.size > REPLACED_DISK_TEXTS_LIMIT && !oldest.done) this.replacedDiskTexts.delete(oldest.value);
  }

  private saveBase(target: Target, base: string): Promise<void> {
    return this.deps.records.set(target.fileId, { path: target.path, base });
  }

  /** Writes the copy until a free path accepts it; the user's disk text must never be lost. */
  private async saveDiskCopy(target: Target, text: string): Promise<void> {
    const candidate = buildConflictPath({ path: target.path, label: "conflict-disk", timestampMs: this.deps.now(), fileId: target.fileId });
    for (;;) {
      const copyPath = await findFreePath(this.deps.vault, candidate);
      if (await this.deps.vault.replace(copyPath, null, text)) {
        this.deps.notify({ kind: "conflict-copy", path: target.path, copyPath });
        return;
      }
    }
  }
}

interface Target {
  fileId: string;
  path: string;
  opened: OpenedDoc;
  disk: string;
}
