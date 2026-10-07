import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, FAST_TIMING, settle, startDevice } from "./fakes/device";

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
