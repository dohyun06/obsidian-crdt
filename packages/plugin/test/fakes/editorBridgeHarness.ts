import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import type { EditorDoc } from "../../src/core/syncEngine";
import { EditorBridge, type EditorDocSource } from "../../src/editor/editorBridge";

const USER = { name: "A", color: "#f00", colorLight: "#f003" };
export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeSource implements EditorDocSource {
  readonly texts = new Map<string, Y.Text>();
  readonly calls: string[] = [];
  readonly editorTexts: Array<string | undefined> = [];
  readonly previousEditorTexts: Array<string | undefined> = [];
  private readonly opens = new Map<string, number>();
  /** Opens and closes as the engine sees them, in order. */
  readonly order: string[] = [];
  /** Runs inside openDocForPath, e.g. to simulate typing while the request is in flight. */
  duringOpen: (() => void) | null = null;
  track(path: string, content: string): Y.Text {
    const text = new Y.Doc().getText("content");
    text.insert(0, content);
    this.texts.set(path, text);
    return text;
  }
  async openDocForPath(path: string, editorText?: string, previousEditorText?: string): Promise<EditorDoc | null> {
    this.editorTexts.push(editorText);
    this.previousEditorTexts.push(previousEditorText);
    const during = this.duringOpen;
    this.duringOpen = null;
    during?.();
    const text = this.texts.get(path);
    if (!text) return null;
    // Stands in for the engine's merge: an unsaved editor text the Y.Text does not have yet is taken over.
    if (editorText !== undefined && editorText !== text.toString()) {
      text.delete(0, text.length);
      text.insert(0, editorText);
    }
    this.opens.set(path, this.openCount(path) + 1);
    this.order.push(`open:${path}`);
    return { fileId: path, text, awareness: null };
  }
  /** Like the engine: every non-null open counts until a close with the same fileId. */
  openCount(fileId: string): number {
    return this.opens.get(fileId) ?? 0;
  }
  captureEditorSnapshot(path: string): void {
    this.calls.push(`capture:${path}`);
  }
  notifyEditorClosed(path: string, fileId?: string): void {
    this.calls.push(`closed:${path}`);
    if (fileId) this.opens.set(fileId, this.openCount(fileId) - 1);
    this.order.push(`closed:${path}`);
  }
}

/** Views created by setup(); each test file destroys them in afterEach. */
export const views: EditorView[] = [];

export function setup() {
  const source = new FakeSource();
  const files = new Map<EditorView, { path: string | null }>();
  const errors: unknown[] = [];
  const debug: string[] = [];
  const bridge = new EditorBridge({
    getSource: () => source,
    getUser: () => USER,
    fileOf: (state) => [...files.entries()].find(([view]) => view.state === state)?.[1].path ?? pendingPath,
    saveEditor: async (_view, path) => {
      source.calls.push(`save:${path}`);
    },
    reportError: (error) => errors.push(error),
    retry: { initialDelayMs: 5, maxDelayMs: 20 },
    debug: (event, fields) => debug.push(`${event} ${JSON.stringify(fields)}`),
  });
  let pendingPath: string | null = null;
  const open = (path: string, content: string) => {
    pendingPath = path;
    const info = { path: path as string | null };
    const view = new EditorView({ state: EditorState.create({ doc: content, extensions: [bridge.extension()] }), parent: document.body });
    files.set(view, info);
    views.push(view);
    return { view, info };
  };
  return { source, bridge, open, errors, debug };
}
