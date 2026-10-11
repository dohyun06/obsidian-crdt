// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setup, tick, views } from "./fakes/editorBridgeHarness";

afterEach(() => views.splice(0).forEach((view) => view.destroy()));

describe("EditorBridge: text typed while unbound", () => {
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
});
