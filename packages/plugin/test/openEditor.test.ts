import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { closeEditor, type Device, fileDocName, openEditor, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function pairWithNote(text: string): Promise<{ hub: LoopbackHub; a: Device; b: Device }> {
  const hub = new LoopbackHub();
  const a = await startDevice(hub, "A");
  const b = await startDevice(hub, "B");
  running.push(a, b);
  a.vault.externalWrite("n.md", text);
  await settle([a, b]);
  return { hub, a, b };
}

const NOTE = "alpha line one\nbeta line two\ngamma line three\n";

describe("files open in a bound editor (spec §4.1)", () => {
  it("does not duplicate text typed in the editor after it closes (regression: stale base while open)", async () => {
    const { hub, a, b } = await pairWithNote(NOTE);
    const text = openEditor(a, "n.md");
    text.insert("alpha line one\n".length, "typed ");
    a.vault.externalWrite("n.md", text.toString()); // Obsidian autosave
    await settle([a, b]);
    closeEditor(a, "n.md");
    await settle([a, b]);
    b.vault.externalWrite("n.md", b.vault.files.get("n.md")!.replace("gamma", "GAMMA"));
    await settle([a, b]);
    const expected = "alpha line one\ntyped beta line two\nGAMMA line three\n";
    expect(a.vault.files.get("n.md")).toBe(expected);
    expect(b.vault.files.get("n.md")).toBe(expected);
    expect(hub.serverText(fileDocName(a, "n.md"))).toBe(expected);
  });

  it("does not duplicate remote edits that were autosaved while open (regression: stale base while open)", async () => {
    const { hub, a, b } = await pairWithNote(NOTE);
    const text = openEditor(a, "n.md");
    b.vault.externalWrite("n.md", NOTE.replace("beta", "remote beta"));
    await settle([a, b]);
    a.vault.externalWrite("n.md", text.toString()); // the editor showed the remote edit and autosaved it
    await settle([a, b]);
    closeEditor(a, "n.md");
    await settle([a, b]);
    b.vault.externalWrite("n.md", b.vault.files.get("n.md")!.replace("gamma", "GAMMA"));
    await settle([a, b]);
    const expected = "alpha line one\nremote beta line two\nGAMMA line three\n";
    expect(a.vault.files.get("n.md")).toBe(expected);
    expect(b.vault.files.get("n.md")).toBe(expected);
    expect(hub.serverText(fileDocName(a, "n.md"))).toBe(expected);
  });

  it("still ignores a lagging autosave while open (regression: editor save lag)", async () => {
    const { hub, a, b } = await pairWithNote("typed");
    openEditor(a, "n.md");
    a.vault.externalWrite("n.md", "typ");
    await settle([a, b]);
    expect(hub.serverText(fileDocName(a, "n.md"))).toBe("typed");
    expect(a.storage.records.get(fileDocName(a, "n.md").split("/")[1]!)?.base).toBe("typed");
  });

  it("writes remote edits that arrived while open to disk once the editor closes", async () => {
    const { a, b } = await pairWithNote(NOTE);
    openEditor(a, "n.md");
    b.vault.externalWrite("n.md", NOTE.replace("beta", "remote beta"));
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe(NOTE); // the editor owns the file while open
    closeEditor(a, "n.md");
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe(NOTE.replace("beta", "remote beta"));
  });
});
