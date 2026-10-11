// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setup, tick, views } from "./fakes/editorBridgeHarness";

afterEach(() => views.splice(0).forEach((view) => view.destroy()));

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
