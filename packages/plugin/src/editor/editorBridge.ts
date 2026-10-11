import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { DebugLog, EditorDoc } from "../core/syncEngine";
import { attachSync, boundPathOf, detachSync, type EditorUser, editorSyncExtension, type FileOf } from "./editorSync";

export interface EditorDocSource {
  /**
   * `editorText`: what the editor shows now; text typed while unbound is merged into the Y.Text before binding.
   * `previousEditorText`: the editor text an earlier request of the same bind already merged; only the delta typed
   * since then is merged.
   */
  openDocForPath(path: string, editorText?: string, previousEditorText?: string): Promise<EditorDoc | null>;
  captureEditorSnapshot(path: string, fileId?: string): void;
  /** Balances one non-null openDocForPath result. */
  notifyEditorClosed(path: string, fileId?: string): void;
}

export interface EditorBridgeDeps {
  getSource(): EditorDocSource | null;
  getUser(): EditorUser;
  fileOf: FileOf;
  saveEditor(view: EditorView, path: string): Promise<void>;
  reportError(error: unknown): void;
  retry?: { initialDelayMs: number; maxDelayMs: number };
  /** Content-free diagnostics: paths and counts only, never note text. */
  debug?: DebugLog;
}

/** A new note is registered by the engine a moment after the editor opens it. */
export const BIND_RETRY = { initialDelayMs: 300, maxDelayMs: 10_000 };
/** How often a bind asks again when the user keeps typing while the doc is being opened. */
export const EDITOR_TEXT_REQUESTS = 3;

interface Binding {
  path: string;
  generation: number;
  attached: boolean;
  /** Set on attach: the engine and doc the editor is bound to, so the close reaches the same engine. */
  opened?: OpenedFor;
}

interface OpenedFor {
  source: EditorDocSource;
  doc: EditorDoc;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class EditorBridge {
  private readonly views = new Set<EditorView>();
  private readonly bindings = new Map<EditorView, Binding>();
  private readonly openCounts = new Map<string, number>();
  private generation = 0;
  /** Set between detachAll and refreshAll so the detach's own transaction does not rebind the editor. */
  private paused = false;

  constructor(private readonly deps: EditorBridgeDeps) {}

  extension(): Extension {
    return [
      editorSyncExtension(this.deps.fileOf),
      ViewPlugin.define((view) => {
        this.views.add(view);
        this.schedule(view);
        return {
          update: (update: ViewUpdate) => this.onUpdate(update),
          destroy: () => {
            this.views.delete(view);
            this.release(view, true).catch((error) => this.deps.reportError(error));
          },
        };
      }),
    ];
  }

  isOpen(path: string): boolean {
    return (this.openCounts.get(path) ?? 0) > 0;
  }

  /** Before a session stops: every bound editor is captured, saved and reported closed. */
  async detachAll(): Promise<void> {
    this.paused = true;
    await Promise.all([...this.bindings.keys()].map((view) => this.release(view, true)));
  }

  /** After a session starts: bind every open editor again. */
  refreshAll(): void {
    this.paused = false;
    this.rebindAll();
  }

  /** Re-evaluate every view's file (e.g. after a vault rename, which changes the path without a transaction). */
  rebindAll(): void {
    this.debug("rebind", { views: this.views.size });
    for (const view of this.views) this.schedule(view);
  }

  private onUpdate(update: ViewUpdate): void {
    const binding = this.bindings.get(update.view);
    const path = this.deps.fileOf(update.state);
    const guardDetached = binding?.attached === true && boundPathOf(update.state) === null;
    if (guardDetached) this.debug("guard-drop", { path: binding.path });
    if (path !== (binding?.path ?? null) || guardDetached) this.schedule(update.view);
  }

  /** Never dispatch inside a CodeMirror update: defer to a microtask. */
  private schedule(view: EditorView): void {
    queueMicrotask(() => this.sync(view).catch((error) => this.deps.reportError(error)));
  }

  private async sync(view: EditorView): Promise<void> {
    if (this.paused || !this.views.has(view)) return;
    const path = this.deps.fileOf(view.state);
    const binding = this.bindings.get(view);
    if (binding && binding.path === path && (!binding.attached || boundPathOf(view.state) === path)) return;
    // Switched or renamed: Obsidian already saved the old file. The engine hears of the close only after the new
    // bind has opened its doc, so a renamed note never looks closed in between (a lagging autosave would be merged).
    const closeOld = binding ? await this.release(view, false, true) : null;
    if (path) await this.bind(view, path, closeOld);
    else closeOld?.();
  }

  private async bind(view: EditorView, path: string, closeOld: (() => void) | null = null): Promise<void> {
    const generation = ++this.generation;
    this.bindings.set(view, { path, generation, attached: false });
    this.debug("bind-requested", { path });
    const { initialDelayMs, maxDelayMs } = this.deps.retry ?? BIND_RETRY;
    let delayMs = initialDelayMs;
    let pendingClose = closeOld;
    const reportOldClosed = () => {
      pendingClose?.();
      pendingClose = null;
    };
    try {
      // The engine may not track the file yet (startup, first sync): keep retrying while this binding is current.
      while (this.isCurrent(view, generation, path)) {
        const opened = await this.openWithEditorText(view, path);
        reportOldClosed();
        if (!this.isCurrent(view, generation, path)) {
          opened?.source.notifyEditorClosed(path, opened.doc.fileId); // keep the engine's open count balanced
          break;
        }
        if (opened) return this.attach(view, path, opened);
        this.debug("bind-retry", { path, delayMs });
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, maxDelayMs);
      }
      this.debug("bind-given-up", { path });
    } catch (error) {
      if (this.bindings.get(view)?.generation === generation) this.bindings.delete(view); // never leave a blocking binding
      throw error;
    } finally {
      reportOldClosed();
    }
  }

  /**
   * Opens the doc with the editor's current text, so text typed while unbound is merged instead of wiped by the
   * alignment. Asks again (bounded) when the user typed while the request was in flight, passing the text the
   * previous request merged so only the newly typed delta is merged (not the whole text a second time). Every
   * superseded open is reported closed after the next one, so the engine's open count stays balanced and never
   * drops to zero.
   */
  private async openWithEditorText(view: EditorView, path: string): Promise<OpenedFor | null> {
    const source = this.deps.getSource();
    if (!source) return null;
    let opened: OpenedFor | null = null;
    let absorbedText: string | undefined;
    for (let request = 1; ; request++) {
      const editorText = view.state.doc.toString();
      const doc = await source.openDocForPath(path, editorText, absorbedText);
      if (opened) source.notifyEditorClosed(path, opened.doc.fileId);
      opened = doc ? { source, doc } : null;
      if (!opened || view.state.doc.toString() === editorText || request > EDITOR_TEXT_REQUESTS) return opened;
      absorbedText = editorText; // this request returned a doc: its editor text is in the Y.Text now
      this.debug("bind-editor-changed", { path, request });
    }
  }

  private attach(view: EditorView, path: string, opened: OpenedFor): void {
    attachSync(view, { path, text: opened.doc.text, awareness: opened.doc.awareness, user: this.deps.getUser() });
    this.openCounts.set(path, (this.openCounts.get(path) ?? 0) + 1);
    const binding = this.bindings.get(view);
    if (binding) {
      binding.attached = true;
      binding.opened = opened;
    }
    this.debug("bind-attached", { path, fileId: opened.doc.fileId });
  }

  private isCurrent(view: EditorView, generation: number, path: string): boolean {
    return !this.paused && this.views.has(view) && this.bindings.get(view)?.generation === generation && this.deps.fileOf(view.state) === path;
  }

  /**
   * Spec §9 close order: capture → save → detach → notify. Every attached binding reports its own close (the engine
   * counts opens per file); with `deferClose` the notify is returned for the caller to run later.
   */
  private async release(view: EditorView, save: boolean, deferClose = false): Promise<(() => void) | null> {
    const binding = this.bindings.get(view);
    if (!binding) return null;
    this.bindings.delete(view);
    if (!binding.attached || !binding.opened) return null;
    const { source, doc } = binding.opened;
    const path = binding.path;
    this.debug("release", { path, save });
    source.captureEditorSnapshot(path, doc.fileId);
    const notifyClosed = () => source.notifyEditorClosed(path, doc.fileId);
    try {
      if (save) await this.deps.saveEditor(view, path);
    } finally {
      if (!this.bindings.has(view)) detachSync(view);
      const remaining = (this.openCounts.get(path) ?? 1) - 1;
      if (remaining > 0) this.openCounts.set(path, remaining);
      else this.openCounts.delete(path);
      if (!deferClose) notifyClosed();
    }
    return deferClose ? notifyClosed : null;
  }

  private debug(event: string, fields: Record<string, string | number | boolean>): void {
    this.deps.debug?.(event, fields);
  }
}
