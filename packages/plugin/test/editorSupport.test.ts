import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { createDevice, type Device, FAST_TIMING, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function pair() {
  const hub = new LoopbackHub();
  const a = await startDevice(hub, "A");
  const b = await startDevice(hub, "B");
  running.push(a, b);
  return { hub, a, b };
}

describe("engine support for editors", () => {
  it("opens the shared Y.Text for a tracked path and returns null otherwise", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "hello");
    await settle([a, b]);
    const doc = await a.engine.openDocForPath("n.md");
    expect(doc?.text.toString()).toBe("hello");
    expect(doc?.awareness).toBeNull();
    expect(await a.engine.openDocForPath("missing.md")).toBeNull();
    expect(await a.engine.openDocForPath(".obsidian/x.md")).toBeNull();
  });

  it("does not duplicate text when the close-time save lags behind a remote edit (explicit snapshot)", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "l1\nl2\n");
    await settle([a, b]);
    a.openInEditor.add("n.md");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    doc.text.insert(0, "typed ");
    a.engine.captureEditorSnapshot("n.md");
    const saved = doc.text.toString();
    await settle([a, b]);
    b.vault.externalWrite("n.md", `${b.vault.files.get("n.md")}B\n`);
    await settle([b]);
    a.vault.externalWrite("n.md", saved); // the editor's save of the captured state lands after the remote edit
    await settle([a]);
    a.openInEditor.delete("n.md");
    a.engine.notifyEditorClosed("n.md");
    await settle([a, b]);
    b.vault.externalWrite("n.md", `${b.vault.files.get("n.md")}C\n`);
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("typed l1\nl2\nB\nC\n");
    expect(b.vault.files.get("n.md")).toBe("typed l1\nl2\nB\nC\n");
  });

  it("does not duplicate text when an autosave lags behind a remote edit (debounced snapshot)", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "l1\nl2\n");
    await settle([a, b]);
    a.openInEditor.add("n.md");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    doc.text.insert(0, "typed ");
    const saved = doc.text.toString();
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.editorSnapshotDebounceMs * 5));
    await settle([a, b]);
    b.vault.externalWrite("n.md", `${b.vault.files.get("n.md")}B\n`);
    await settle([b]);
    a.vault.externalWrite("n.md", saved);
    await settle([a]);
    a.openInEditor.delete("n.md");
    a.engine.notifyEditorClosed("n.md");
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("typed l1\nl2\nB\n");
    expect(b.vault.files.get("n.md")).toBe("typed l1\nl2\nB\n");
  });
});

describe("editor support guards", () => {
  it("returns null for an unreconciled file until it settles", async () => {
    const hub = new LoopbackHub();
    const device = createDevice(hub, "A", { files: { "n.md": "x" }, online: false });
    running.push(device);
    await device.storage.saveRecord("11111111-1111-4111-8111-111111111111", { path: "n.md", base: null });
    await device.storage.setFlag("bootstrapped", true);
    await device.engine.start();
    expect(await device.engine.openDocForPath("n.md")).toBeNull();
    device.syncer.setOnline(true);
    await settle([device]);
    expect(await device.engine.openDocForPath("n.md")).not.toBeNull();
  });

  it("returns null and does not throw after stop", async () => {
    const { a } = await pair();
    a.vault.externalWrite("n.md", "hi");
    await settle([a]);
    await a.engine.stop();
    expect(await a.engine.openDocForPath("n.md")).toBeNull();
    expect(() => a.engine.captureEditorSnapshot("n.md")).not.toThrow();
  });

  it("keeps history across a rename while open, and forgets it after close", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "l1\nl2\n");
    await settle([a, b]);
    a.openInEditor.add("n.md");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    doc.text.insert(0, "typed ");
    a.engine.captureEditorSnapshot("n.md");
    const saved = doc.text.toString();
    await settle([a, b]);
    b.vault.externalWrite("n.md", `${b.vault.files.get("n.md")}B\n`);
    await settle([b]);
    await a.vault.rename("n.md", "m.md");
    a.openInEditor.delete("n.md");
    a.openInEditor.add("m.md");
    await settle([a, b]);
    a.vault.externalWrite("m.md", saved); // lagging autosave of the pre-rename state
    await settle([a]);
    a.openInEditor.delete("m.md");
    a.engine.notifyEditorClosed("m.md");
    await settle([a, b]);
    expect(a.vault.files.get("m.md")).toBe("typed l1\nl2\nB\n");
    // history is gone after close: the old state is now an ordinary outside edit and is merged
    a.vault.externalWrite("m.md", saved);
    await settle([a, b]);
    expect(a.vault.files.get("m.md")).toBe(b.vault.files.get("m.md"));
    expect(a.vault.files.get("m.md")).not.toBe("typed l1\nl2\nB\n");
  });

  it("merges an outside edit that is not in the history", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "l1\nl2\n");
    await settle([a, b]);
    a.openInEditor.add("n.md");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    doc.text.insert(0, "typed ");
    a.engine.captureEditorSnapshot("n.md");
    await settle([a, b]);
    a.openInEditor.delete("n.md");
    a.vault.externalWrite("n.md", "l1\nl2\nOUT\n");
    a.engine.notifyEditorClosed("n.md");
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("typed l1\nl2\nOUT\n");
    expect(b.vault.files.get("n.md")).toBe("typed l1\nl2\nOUT\n");
  });
});
