import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { normalizeVaultPath } from "@obsidian-crdt/shared";
import type { Wiring } from "./engineWiring";
import type { KeyedDebouncer } from "./scheduling";

export interface EditorDoc {
  fileId: string;
  text: Y.Text;
  awareness: Awareness | null;
}

/** Content-free diagnostics: never pass note text or tokens in `fields`. */
export type DebugLog = (event: string, fields: Record<string, string | number | boolean>) => void;

export interface EditorAccessDeps {
  /** Path-based signal from the editor layer; either it or an open fileId means "open". */
  isPathOpen: (path: string) => boolean;
  wiring: () => Wiring | null;
  enqueue: (task: (wiring: Wiring) => Promise<void>) => Promise<void>;
  /** Brings disk and Y.Text together for a file nobody shows in an editor any more. */
  flushRemoteText: (wiring: Wiring, fileId: string) => Promise<void>;
  debouncer: KeyedDebouncer;
  snapshotDebounceMs: number;
  isStopped: () => boolean;
  debug: DebugLog;
}

/**
 * The engine's editor-facing side (spec §4.1, §9 close order). Files are tracked as open by fileId, so a rename
 * of an open note does not make it look closed before the editor has rebound to the new path.
 */
export class EditorAccess {
  private readonly openCounts = new Map<string, number>();

  constructor(private readonly deps: EditorAccessDeps) {}

  isOpen(fileId: string | null, path: string): boolean {
    return (fileId !== null && this.openCounts.has(fileId)) || this.deps.isPathOpen(path);
  }

  /**
   * The shared Y.Text for a tracked file, after every earlier vault event has been handled. Each non-null result
   * counts the file as open until a matching notifyEditorClosed. `editorText` is what the editor shows right now:
   * text typed while it was unbound is merged in before it is aligned to the Y.Text.
   */
  async openDocForPath(path: string, editorText?: string): Promise<EditorDoc | null> {
    const normalized = normalizeVaultPath(path);
    let result = null as EditorDoc | null;
    let outcome = "untracked";
    await this.deps.enqueue(async ({ records, docs, reconciler }) => {
      const fileId = records.findIdByPath(normalized);
      if (!fileId) return;
      // base === null: not reconciled yet; an editor bound to this Y.Text could wipe the disk (spec §4.5).
      if (records.get(fileId)?.base === null) return void (outcome = "not-reconciled");
      outcome = editorText === undefined ? "opened" : `absorbed-${await reconciler.absorbEditorText(fileId, editorText)}`;
      const opened = await docs.open(fileId);
      this.markOpen(fileId);
      result = { fileId, text: opened.text, awareness: opened.sync.awareness };
    });
    if (this.deps.isStopped()) return null;
    this.deps.debug("open-doc", { path: normalized, outcome });
    return result;
  }

  /** Remember the current Y.Text of an open file right before the editor saves it (spec §9 close order). */
  captureEditorSnapshot(path: string, fileId?: string): void {
    const id = fileId ?? this.deps.wiring()?.records.findIdByPath(normalizeVaultPath(path));
    if (id) this.captureSnapshot(id);
  }

  /**
   * Called when a bound editor closes. Remote edits and modify events were left to the editor while it was open
   * (spec §4.1); now the disk and Y.Text are brought together again.
   */
  notifyEditorClosed(path: string, fileId?: string): void {
    const normalized = normalizeVaultPath(path);
    const closingId = fileId ?? this.deps.wiring()?.records.findIdByPath(normalized) ?? null;
    if (closingId) this.markClosed(closingId);
    // Another pane may still show the file: its pending snapshot is still needed then.
    if (closingId && !this.openCounts.has(closingId)) this.deps.debouncer.cancel(`snap:${closingId}`);
    this.deps.debug("editor-closed", { fileId: closingId ?? "", stillOpen: closingId !== null && this.openCounts.has(closingId) });
    void this.deps.enqueue(async (wiring) => {
      const id = closingId ?? wiring.records.findIdByPath(normalized);
      if (!id) return;
      await this.deps.flushRemoteText(wiring, id);
      if (!this.isOpen(id, wiring.records.get(id)?.path ?? normalized)) wiring.history.forget(id);
    });
  }

  /** While a file is open, its recent Y.Text states are remembered: the editor's autosave may lag behind. */
  onTextChanged(fileId: string): void {
    if (this.deps.isStopped() || !this.isOpenNow(fileId)) return;
    this.deps.debouncer.schedule(`snap:${fileId}`, this.deps.snapshotDebounceMs, () => {
      if (this.isOpenNow(fileId)) this.captureSnapshot(fileId);
    });
  }

  private isOpenNow(fileId: string): boolean {
    const record = this.deps.wiring()?.records.get(fileId);
    return record !== null && record !== undefined && this.isOpen(fileId, record.path);
  }

  private captureSnapshot(fileId: string): void {
    const wiring = this.deps.wiring();
    const opened = wiring?.docs.peek(fileId);
    if (wiring && opened) wiring.history.record(fileId, opened.text.toString());
  }

  private markOpen(fileId: string): void {
    const count = (this.openCounts.get(fileId) ?? 0) + 1;
    this.openCounts.set(fileId, count);
    this.deps.debug("editor-open", { fileId, count });
  }

  private markClosed(fileId: string): void {
    const remaining = (this.openCounts.get(fileId) ?? 0) - 1;
    if (remaining > 0) this.openCounts.set(fileId, remaining);
    else this.openCounts.delete(fileId);
  }
}
