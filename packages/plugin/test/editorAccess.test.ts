import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function pairWithNote(text: string): Promise<{ a: Device; b: Device }> {
  const hub = new LoopbackHub();
  const a = await startDevice(hub, "A");
  const b = await startDevice(hub, "B");
  running.push(a, b);
  a.vault.externalWrite("n.md", text);
  await settle([a, b]);
  return { a, b };
}

describe("editor text absorbed when an editor binds (regression: unsaved text wiped on attach)", () => {
  it("merges text typed while the editor was unbound into the Y.Text", async () => {
    const { a, b } = await pairWithNote("hello\n");
    a.openInEditor.add("n.md"); // the editor shows the file, so remote edits are not flushed to disk meanwhile
    b.vault.externalWrite("n.md", "B line\nhello\n");
    await settle([a, b]);
    const doc = await a.engine.openDocForPath("n.md", "hello\nworld\n");
    expect(doc?.text.toString()).toBe("B line\nhello\nworld\n");
    await settle([a, b]);
    expect(b.vault.files.get("n.md")).toBe("B line\nhello\nworld\n");
  });

  it("takes unsaved editor text when the Y.Text still holds the base", async () => {
    const { a, b } = await pairWithNote("hello\n");
    const doc = await a.engine.openDocForPath("n.md", "hello\ntyped while unbound\n");
    expect(doc?.text.toString()).toBe("hello\ntyped while unbound\n");
    await settle([a, b]);
    expect(b.vault.files.get("n.md")).toBe("hello\ntyped while unbound\n");
  });

  it("does not revert a remote edit when the editor still shows the disk text the engine just replaced", async () => {
    const { a, b } = await pairWithNote("v1\n");
    b.vault.externalWrite("n.md", "v1\nremote\n"); // A's engine writes it to A's disk before the editor reloads
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("v1\nremote\n");
    const doc = await a.engine.openDocForPath("n.md", "v1\n"); // Obsidian has not reloaded the editor yet
    expect(doc?.text.toString()).toBe("v1\nremote\n");
  });

  it("keeps the Y.Text and saves the editor text as a conflict copy when they cannot merge", async () => {
    const { a, b } = await pairWithNote("The quick brown fox jumps over the lazy dog");
    a.openInEditor.add("n.md");
    b.vault.externalWrite("n.md", "0123456789");
    await settle([a, b]);
    const doc = await a.engine.openDocForPath("n.md", "The quick red fox jumps over the lazy dog");
    expect(doc?.text.toString()).toBe("0123456789");
    const copies = [...a.vault.files.entries()].filter(([path]) => path.includes("conflict-disk"));
    expect(copies.map(([, text]) => text)).toEqual(["The quick red fox jumps over the lazy dog"]);
    expect(a.notices.some((notice) => notice.kind === "conflict-copy")).toBe(true);
  });
});

describe("files open in an editor are tracked by fileId (regression: rename of an open note)", () => {
  it("does not merge a lagging autosave a second time when the open note is renamed", async () => {
    const { a, b } = await pairWithNote("hello\n");
    a.openInEditor.add("n.md");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    doc.text.insert(6, "abc"); // typing...
    const intermediate = doc.text.toString();
    doc.text.insert(9, "def"); // ...continues before any idle snapshot
    a.vault.externalWrite("n.md", intermediate); // Obsidian autosave of a mid-burst state
    await settle([a]);
    // the user renames the still-open note; the bridge has not rebound yet (its open set is keyed by the old path)
    a.vault.externalRename("n.md", "m.md");
    await settle([a, b]);
    expect(doc.text.toString()).toBe("hello\nabcdef");
  });

  it("treats a file as open by fileId even when the path-based signal is off", async () => {
    const { a, b } = await pairWithNote("hello\n");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    b.vault.externalWrite("n.md", "hello\nremote\n");
    await settle([a, b]);
    expect(doc.text.toString()).toBe("hello\nremote\n");
    expect(a.vault.files.get("n.md")).toBe("hello\n"); // the editor owns the open file
    a.engine.notifyEditorClosed("n.md", doc.fileId);
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("hello\nremote\n");
  });

  it("keeps a file open until every editor that opened it has closed", async () => {
    const { a, b } = await pairWithNote("hello\n");
    const first = (await a.engine.openDocForPath("n.md"))!;
    await a.engine.openDocForPath("n.md");
    a.engine.notifyEditorClosed("n.md", first.fileId);
    b.vault.externalWrite("n.md", "hello\nremote\n");
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("hello\n");
    a.engine.notifyEditorClosed("n.md", first.fileId);
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("hello\nremote\n");
  });
});
