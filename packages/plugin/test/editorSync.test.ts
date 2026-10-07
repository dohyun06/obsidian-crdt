// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { alignmentChanges, attachSync, boundPathOf, detachSync, editorSyncExtension } from "../src/editor/editorSync";

const USER = { name: "A", color: "#f00", colorLight: "#f003" };
const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function editor(doc: string, info: { path: string | null }) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [editorSyncExtension(() => info.path)] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function yText(content: string): Y.Text {
  const text = new Y.Doc().getText("content");
  text.insert(0, content);
  return text;
}

const type = (view: EditorView, at: number, insert: string) => view.dispatch({ changes: { from: at, insert } });

describe("editorSync", () => {
  it("aligns the editor to the Y.Text without changing the Y.Text", () => {
    const text = yText("new text");
    let updates = 0;
    text.doc!.on("update", () => updates++);
    const view = editor("old", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    expect(view.state.doc.toString()).toBe("new text");
    expect(updates).toBe(0);
    expect(boundPathOf(view.state)).toBe("a.md");
  });

  it("syncs typing to the Y.Text and remote edits to the editor", () => {
    const text = yText("hello");
    const view = editor("hello", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: new Awareness(text.doc!), user: USER });
    type(view, 5, " world");
    expect(text.toString()).toBe("hello world");
    text.insert(0, ">> ");
    expect(view.state.doc.toString()).toBe(">> hello world");
  });

  it("stops syncing after detach", () => {
    const text = yText("hello");
    const view = editor("hello", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    detachSync(view);
    type(view, 0, "x");
    expect(text.toString()).toBe("hello");
    expect(boundPathOf(view.state)).toBeNull();
  });

  it("never pushes another file's content into the bound Y.Text when the view switches files", () => {
    const text = yText("note A");
    const info = { path: "a.md" as string | null };
    const view = editor("note A", info);
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    info.path = "b.md"; // Obsidian's file getter changes before it loads the new content
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "note B" } });
    expect(text.toString()).toBe("note A");
    expect(boundPathOf(view.state)).toBeNull();
  });

  it("keeps emoji intact when aligning", () => {
    const text = yText("x😁y");
    const view = editor("x😀y", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    expect(view.state.doc.toString()).toBe("x😁y");
  });

  it("undoes local typing through the Yjs undo manager", () => {
    const text = yText("abc");
    const view = editor("abc", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    type(view, 3, "d");
    const undo = yUndoManagerKeymap.find((binding) => binding.key === "Mod-z")!;
    undo.run!(view);
    expect(text.toString()).toBe("abc");
  });

  it("computes minimal changes in original positions", () => {
    expect(alignmentChanges("abcdef", "abXdeYf")).toEqual([
      { from: 2, to: 3, insert: "" },
      { from: 3, to: 3, insert: "X" },
      { from: 5, to: 5, insert: "Y" },
    ]);
  });

  it("rebinds after a stale binding without losing sync", () => {
    const a = yText("A");
    const b = yText("B");
    const info = { path: "a.md" as string | null };
    const view = editor("A", info);
    attachSync(view, { path: "a.md", text: a, awareness: null, user: USER });
    info.path = "b.md";
    attachSync(view, { path: "b.md", text: b, awareness: null, user: USER });
    type(view, 1, "!");
    expect(b.toString()).toBe("B!");
    expect(a.toString()).toBe("A");
    expect(boundPathOf(view.state)).toBe("b.md");
  });

  it("destroys the previous undo manager on re-attach", () => {
    const a = yText("A");
    const info = { path: "a.md" as string | null };
    const view = editor("A", info);
    attachSync(view, { path: "a.md", text: a, awareness: null, user: USER });
    const listeners = () => a.doc!._observers.get("afterTransaction")?.size ?? 0;
    const bound = listeners();
    info.path = "b.md";
    attachSync(view, { path: "b.md", text: yText("B"), awareness: null, user: USER });
    detachSync(view);
    expect(listeners()).toBeLessThan(bound);
  });

  it("clears the local cursor on detach", () => {
    const text = yText("abc");
    const awareness = new Awareness(text.doc!);
    const view = editor("abc", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness, user: USER });
    awareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
    detachSync(view);
    expect(awareness.getLocalState()?.cursor).toBeNull();
  });

  it("drops the binding when setState switches files", () => {
    const text = yText("note A");
    const info = { path: "a.md" as string | null };
    const view = editor("note A", info);
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    info.path = "b.md";
    view.setState(EditorState.create({ doc: "note B", extensions: [editorSyncExtension(() => info.path)] }));
    type(view, 0, "x");
    expect(text.toString()).toBe("note A");
    expect(boundPathOf(view.state)).toBeNull();
  });
});
