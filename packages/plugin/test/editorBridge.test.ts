// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EditorDoc } from "../src/core/syncEngine";
import { EditorBridge, type EditorDocSource } from "../src/editor/editorBridge";

const USER = { name: "A", color: "#f00", colorLight: "#f003" };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSource implements EditorDocSource {
  readonly texts = new Map<string, Y.Text>();
  readonly calls: string[] = [];
  track(path: string, content: string): Y.Text {
    const text = new Y.Doc().getText("content");
    text.insert(0, content);
    this.texts.set(path, text);
    return text;
  }
  async openDocForPath(path: string): Promise<EditorDoc | null> {
    const text = this.texts.get(path);
    return text ? { fileId: path, text, awareness: null } : null;
  }
  captureEditorSnapshot(path: string): void {
    this.calls.push(`capture:${path}`);
  }
  notifyEditorClosed(path: string): void {
    this.calls.push(`closed:${path}`);
  }
}

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function setup() {
  const source = new FakeSource();
  const files = new Map<EditorView, { path: string | null }>();
  const errors: unknown[] = [];
  const bridge = new EditorBridge({
    getSource: () => source,
    getUser: () => USER,
    fileOf: (state) => [...files.entries()].find(([view]) => view.state === state)?.[1].path ?? pendingPath,
    saveEditor: async (_view, path) => {
      source.calls.push(`save:${path}`);
    },
    reportError: (error) => errors.push(error),
    retry: { initialDelayMs: 5, maxDelayMs: 20 },
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
  return { source, bridge, open, errors };
}

describe("EditorBridge", () => {
  it("binds an opened file and syncs typing", async () => {
    const { source, bridge, open } = setup();
    const text = source.track("a.md", "hello");
    const { view } = open("a.md", "hello");
    await tick();
    view.dispatch({ changes: { from: 5, insert: "!" } });
    expect(text.toString()).toBe("hello!");
    expect(bridge.isOpen("a.md")).toBe(true);
  });

  it("captures, saves and only then reports a closed editor", async () => {
    const { source, bridge, open } = setup();
    source.track("a.md", "hello");
    const { view } = open("a.md", "hello");
    await tick();
    views.splice(views.indexOf(view), 1);
    view.destroy();
    await tick();
    expect(source.calls).toEqual(["capture:a.md", "save:a.md", "closed:a.md"]);
    expect(bridge.isOpen("a.md")).toBe(false);
  });

  it("rebinds when the view switches files, without saving or touching the old text", async () => {
    const { source, open } = setup();
    const a = source.track("a.md", "note A");
    const b = source.track("b.md", "note B");
    const { view, info } = open("a.md", "note A");
    await tick();
    info.path = "b.md";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "note B" } });
    await tick();
    view.dispatch({ changes: { from: 6, insert: "!" } });
    expect(a.toString()).toBe("note A");
    expect(b.toString()).toBe("note B!");
    expect(source.calls).toEqual(["capture:a.md", "closed:a.md"]);
  });

  // Review Focus 1
  it("keeps a file open while another pane still shows it", async () => {
    const { source, bridge, open } = setup();
    source.track("a.md", "x");
    const first = open("a.md", "x");
    const second = open("a.md", "x");
    await tick();
    views.splice(views.indexOf(first.view), 1);
    first.view.destroy();
    await tick();
    expect(bridge.isOpen("a.md")).toBe(true);
    expect(source.calls).not.toContain("closed:a.md");
    views.splice(views.indexOf(second.view), 1);
    second.view.destroy();
    await tick();
    expect(source.calls.filter((call) => call === "closed:a.md")).toHaveLength(1);
  });

  // Review Focus 2
  it("retries binding until the engine tracks the file, and gives up quietly", async () => {
    const { source, bridge, open } = setup();
    const late = open("new.md", "");
    const never = open("huge.md", "big");
    await tick(8);
    const text = source.track("new.md", "");
    await tick(30);
    late.view.dispatch({ changes: { from: 0, insert: "typed" } });
    expect(text.toString()).toBe("typed");
    expect(bridge.isOpen("huge.md")).toBe(false);
    never.view.dispatch({ changes: { from: 0, insert: "x" } });
  });

  // Review Focus 3
  it("follows a rename of the open file", async () => {
    const { source, bridge, open } = setup();
    const text = source.track("old.md", "body");
    const { view, info } = open("old.md", "body");
    await tick();
    source.texts.set("new.md", text);
    info.path = "new.md";
    bridge.rebindAll(); // the vault rename event: no editor transaction accompanies the path change
    await tick();
    view.dispatch({ changes: { from: 4, insert: "!" } });
    expect(text.toString()).toBe("body!");
    expect(bridge.isOpen("new.md")).toBe(true);
    expect(bridge.isOpen("old.md")).toBe(false);
  });

  it("binds a file tracked only after many retries", async () => {
    const { source, bridge, open } = setup();
    const { view } = open("slow.md", "");
    await tick(120); // far beyond a fixed attempt count at 5-20 ms
    const text = source.track("slow.md", "");
    await tick(60);
    view.dispatch({ changes: { from: 0, insert: "ok" } });
    expect(text.toString()).toBe("ok");
    expect(bridge.isOpen("slow.md")).toBe(true);
  });

  it("refreshAll after a long-unbound editor binds it once tracked", async () => {
    const { source, bridge, open, errors } = setup();
    const { view } = open("late.md", "");
    await tick(60);
    const text = source.track("late.md", "");
    bridge.refreshAll();
    await tick(40);
    view.dispatch({ changes: { from: 0, insert: "y" } });
    expect(text.toString()).toBe("y");
    expect(errors).toEqual([]);
  });

  it("detaches every editor for a session restart and binds them again", async () => {
    const { source, bridge, open } = setup();
    const text = source.track("a.md", "x");
    const { view } = open("a.md", "x");
    await tick();
    await bridge.detachAll();
    expect(source.calls).toEqual(["capture:a.md", "save:a.md", "closed:a.md"]);
    expect(bridge.isOpen("a.md")).toBe(false);
    bridge.refreshAll();
    await tick();
    view.dispatch({ changes: { from: 1, insert: "1" } });
    expect(text.toString()).toBe("x1");
    expect(bridge.isOpen("a.md")).toBe(true);
  });
});
