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

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function setup() {
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
    expect(source.openCount("a.md")).toBe(1); // the engine still counts the file as open
    views.splice(views.indexOf(second.view), 1);
    second.view.destroy();
    await tick();
    expect(source.openCount("a.md")).toBe(0);
    expect(source.calls.filter((call) => call === "closed:a.md")).toHaveLength(2);
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

  it("keeps text typed while the editor was unbound (regression: attach wiped unsaved text)", async () => {
    const { source, open } = setup();
    const text = source.track("a.md", "x");
    const { view } = open("pending.md", "x");
    await tick(8); // untracked: the bridge keeps retrying
    view.dispatch({ changes: { from: 1, insert: " typed while unbound" } }); // not saved yet
    source.texts.set("pending.md", text);
    await tick(40);
    expect(view.state.doc.toString()).toBe("x typed while unbound");
    expect(text.toString()).toBe("x typed while unbound");
  });

  it("asks again when the editor text changes while the doc is being opened", async () => {
    const { source, open } = setup();
    const text = source.track("a.md", "x");
    let view: ReturnType<typeof open>["view"] | null = null;
    source.duringOpen = () => view!.dispatch({ changes: { from: 1, insert: "y" } });
    view = open("a.md", "x").view;
    await tick(10);
    expect(source.editorTexts).toEqual(["x", "xy"]);
    expect(text.toString()).toBe("xy");
    expect(view.state.doc.toString()).toBe("xy");
  });

  it("passes the text absorbed by the previous request, so only the newly typed delta is merged (regression: duplication)", async () => {
    const { source, open } = setup();
    source.track("a.md", "x");
    let view: ReturnType<typeof open>["view"] | null = null;
    source.duringOpen = () => {
      view!.dispatch({ changes: { from: 1, insert: "1" } }); // typing during request 1
      source.duringOpen = () => view!.dispatch({ changes: { from: 2, insert: "2" } }); // ...and during request 2
    };
    view = open("a.md", "x").view;
    await tick(10);
    expect(source.editorTexts).toEqual(["x", "x1", "x12"]);
    expect(source.previousEditorTexts).toEqual([undefined, "x", "x1"]);
    expect(source.openCount("a.md")).toBe(1);
  });

  it("passes no previous editor text after a request that found no doc", async () => {
    const { source, open } = setup();
    open("late.md", "x");
    await tick(8);
    source.track("late.md", "x");
    await tick(30);
    expect(source.previousEditorTexts.every((previous) => previous === undefined)).toBe(true);
  });

  it("reports the old path closed only after the renamed note is opened again", async () => {
    const { source, bridge, open } = setup();
    const text = source.track("old.md", "body");
    const { info } = open("old.md", "body");
    await tick();
    source.texts.set("new.md", text);
    info.path = "new.md";
    bridge.rebindAll();
    await tick();
    expect(source.order.indexOf("closed:old.md")).toBeGreaterThan(source.order.indexOf("open:new.md"));
    expect(source.openCount("old.md")).toBe(0);
    expect(source.openCount("new.md")).toBe(1);
  });

  it("reports an opened doc closed again when the binding is abandoned meanwhile", async () => {
    const { source, bridge, open } = setup();
    source.track("a.md", "x");
    let info: { path: string | null } | null = null;
    source.duringOpen = () => {
      info!.path = "other.md"; // the pane switched to an untracked file while the doc was being opened
    };
    info = open("a.md", "x").info;
    await tick(10);
    expect(source.openCount("a.md")).toBe(0);
    expect(bridge.isOpen("a.md")).toBe(false);
  });

  it("logs binding steps without note text", async () => {
    const { source, bridge, open, debug } = setup();
    source.track("a.md", "secret");
    const late = open("late.md", "secret too");
    const { view, info } = open("a.md", "secret");
    await tick(8);
    info.path = "b.md"; // the guard drops the binding on the next transaction
    view.dispatch({ changes: { from: 0, insert: "secret!" } });
    bridge.rebindAll();
    late.view.destroy();
    views.splice(views.indexOf(late.view), 1);
    await tick(30);
    const names = debug.map((line) => line.split(" ")[0]);
    for (const name of ["bind-requested", "bind-attached", "bind-retry", "bind-given-up", "guard-drop", "release", "rebind"]) {
      expect(names).toContain(name);
    }
    expect(debug.join("\n")).not.toContain("secret");
  });
});
