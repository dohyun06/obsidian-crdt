import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorDoc } from "../core/syncEngine";
import { attachSync, boundPathOf, detachSync, type EditorUser, editorSyncExtension, type FileOf } from "./editorSync";

export interface EditorDocSource {
  openDocForPath(path: string): Promise<EditorDoc | null>;
  captureEditorSnapshot(path: string): void;
  notifyEditorClosed(path: string): void;
}

export interface EditorBridgeDeps {
  getSource(): EditorDocSource | null;
  getUser(): EditorUser;
  fileOf: FileOf;
  saveEditor(view: EditorView, path: string): Promise<void>;
  retry?: { attempts: number; delayMs: number };
}

/** A new note is registered by the engine a moment after the editor opens it. */
export const BIND_RETRY = { attempts: 10, delayMs: 300 };

interface Binding {
  path: string;
  generation: number;
  attached: boolean;
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
            void this.release(view, true);
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
    for (const view of this.views) this.schedule(view);
  }

  private onUpdate(update: ViewUpdate): void {
    const binding = this.bindings.get(update.view);
    const path = this.deps.fileOf(update.state);
    const guardDetached = binding?.attached === true && boundPathOf(update.state) === null;
    if (path !== (binding?.path ?? null) || guardDetached) this.schedule(update.view);
  }

  /** Never dispatch inside a CodeMirror update: defer to a microtask. */
  private schedule(view: EditorView): void {
    queueMicrotask(() => void this.sync(view));
  }

  private async sync(view: EditorView): Promise<void> {
    if (this.paused || !this.views.has(view)) return;
    const path = this.deps.fileOf(view.state);
    const binding = this.bindings.get(view);
    if (binding && binding.path === path && (!binding.attached || boundPathOf(view.state) === path)) return;
    if (binding) await this.release(view, false); // switched or renamed: Obsidian already saved the old file
    if (path) await this.bind(view, path);
  }

  private async bind(view: EditorView, path: string): Promise<void> {
    const generation = ++this.generation;
    this.bindings.set(view, { path, generation, attached: false });
    const { attempts, delayMs } = this.deps.retry ?? BIND_RETRY;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const doc = (await this.deps.getSource()?.openDocForPath(path)) ?? null;
      if (!this.isCurrent(view, generation, path)) return;
      if (doc) return this.attach(view, path, doc);
      await sleep(delayMs);
      if (!this.isCurrent(view, generation, path)) return;
    }
  }

  private attach(view: EditorView, path: string, doc: EditorDoc): void {
    attachSync(view, { path, text: doc.text, awareness: doc.awareness, user: this.deps.getUser() });
    this.openCounts.set(path, (this.openCounts.get(path) ?? 0) + 1);
    const binding = this.bindings.get(view);
    if (binding) binding.attached = true;
  }

  private isCurrent(view: EditorView, generation: number, path: string): boolean {
    return this.views.has(view) && this.bindings.get(view)?.generation === generation && this.deps.fileOf(view.state) === path;
  }

  /** Spec §9 close order: capture → save → detach → notify (only when no other pane shows the file). */
  private async release(view: EditorView, save: boolean): Promise<void> {
    const binding = this.bindings.get(view);
    if (!binding) return;
    this.bindings.delete(view);
    if (!binding.attached) return;
    const source = this.deps.getSource();
    source?.captureEditorSnapshot(binding.path);
    try {
      if (save) await this.deps.saveEditor(view, binding.path);
    } finally {
      detachSync(view);
      const remaining = (this.openCounts.get(binding.path) ?? 1) - 1;
      if (remaining > 0) this.openCounts.set(binding.path, remaining);
      else this.openCounts.delete(binding.path);
      if (remaining <= 0) source?.notifyEditorClosed(binding.path);
    }
  }
}
