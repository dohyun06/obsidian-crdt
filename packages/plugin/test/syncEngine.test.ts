import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, fileDocName, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function pair(): Promise<{ hub: LoopbackHub; a: Device; b: Device }> {
  const hub = new LoopbackHub();
  const a = await startDevice(hub, "A");
  const b = await startDevice(hub, "B");
  running.push(a, b);
  return { hub, a, b };
}

describe("SyncEngine — live changes between two devices", () => {
  it("propagates a new note", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("notes/new.md", "# hello");
    await settle([a, b]);
    expect(b.vault.files.get("notes/new.md")).toBe("# hello");
  });

  it("propagates edits", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("a.md", "one");
    await settle([a, b]);
    a.vault.externalWrite("a.md", "one two");
    await settle([a, b]);
    expect(b.vault.files.get("a.md")).toBe("one two");
  });

  it("merges concurrent edits to different lines", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("a.md", "l1\nl2\nl3\n");
    await settle([a, b]);
    a.vault.externalWrite("a.md", "L1\nl2\nl3\n");
    b.vault.externalWrite("a.md", "l1\nl2\nL3\n");
    await settle([a, b]);
    expect(a.vault.files.get("a.md")).toBe("L1\nl2\nL3\n");
    expect(b.vault.files.get("a.md")).toBe("L1\nl2\nL3\n");
  });

  it("propagates renames without changing the file id", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("old.md", "body");
    await settle([a, b]);
    const docName = fileDocName(a, "old.md");
    a.vault.externalRename("old.md", "folder/new.md");
    await settle([a, b]);
    expect(b.vault.files.has("old.md")).toBe(false);
    expect(b.vault.files.get("folder/new.md")).toBe("body");
    expect(fileDocName(b, "folder/new.md")).toBe(docName);
  });

  it("moves remote deletions to the trash", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("gone.md", "bye");
    await settle([a, b]);
    a.vault.externalDelete("gone.md");
    await settle([a, b]);
    expect(b.vault.files.has("gone.md")).toBe(false);
    expect(b.vault.trashed).toEqual([{ path: "gone.md", text: "bye" }]);
  });

  it("treats delete + create with the same content as a rename (git mv)", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("x.md", "same body");
    await settle([a, b]);
    const docName = fileDocName(a, "x.md");
    a.vault.externalDelete("x.md");
    a.vault.externalWrite("y.md", "same body");
    await settle([a, b]);
    expect(fileDocName(a, "y.md")).toBe(docName);
    expect(b.vault.files.get("y.md")).toBe("same body");
    expect(b.vault.trashed).toEqual([]);
  });

  it("ignores disk modify events for a file open in a bound editor (regression: editor save lag)", async () => {
    const { hub, a, b } = await pair();
    a.vault.externalWrite("open.md", "typed");
    await settle([a, b]);
    a.openInEditor.add("open.md");
    a.vault.externalWrite("open.md", "typ");
    await settle([a, b]);
    expect(hub.serverText(fileDocName(a, "open.md"))).toBe("typed");
  });

  it("pauses mass deletions until confirmed", async () => {
    const { a, b } = await pair();
    const paths = ["1.md", "2.md", "3.md", "4.md", "5.md"];
    for (const path of paths) a.vault.externalWrite(path, path);
    await settle([a, b]);
    for (const path of paths) a.vault.externalDelete(path);
    await settle([a, b]);
    expect(a.notices).toContainEqual({ kind: "mass-delete-paused", paths });
    expect(b.vault.files.size).toBe(5);
    await a.engine.confirmPausedDeletes();
    await settle([a, b]);
    expect(b.vault.files.size).toBe(0);
  });

  it("restores paused mass deletions on request", async () => {
    const { a, b } = await pair();
    const paths = ["1.md", "2.md", "3.md", "4.md", "5.md"];
    for (const path of paths) a.vault.externalWrite(path, `body ${path}`);
    await settle([a, b]);
    for (const path of paths) a.vault.externalDelete(path);
    await settle([a, b]);
    await a.engine.restorePausedDeletes();
    await settle([a, b]);
    expect(a.vault.files.get("3.md")).toBe("body 3.md");
    expect(b.vault.files.size).toBe(5);
  });

  // Review Focus 1
  it("keeps NFD file names byte-for-byte", async () => {
    const { a, b } = await pair();
    const nfd = "한글 노트.md".normalize("NFD");
    a.vault.externalWrite(nfd, "본문");
    await settle([a, b]);
    expect(b.vault.files.get(nfd)).toBe("본문");
    b.vault.externalWrite(nfd, "본문 수정");
    await settle([a, b]);
    expect([...a.vault.files.keys()]).toEqual([nfd]);
    expect(a.vault.files.get(nfd)).toBe("본문 수정");
  });

  // Review Focus 2
  it("does not pair empty files as a rename", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("empty-1.md", "");
    await settle([a, b]);
    const firstDoc = fileDocName(a, "empty-1.md");
    a.vault.externalDelete("empty-1.md");
    a.vault.externalWrite("empty-2.md", "");
    await settle([a, b]);
    expect(fileDocName(a, "empty-2.md")).not.toBe(firstDoc);
    expect(b.vault.files.has("empty-1.md")).toBe(false);
    expect(b.vault.files.get("empty-2.md")).toBe("");
  });

  // Review Focus 3
  it("starts syncing a file once it shrinks under the size limit", async () => {
    const { a, b } = await pair();
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    a.vault.externalWrite("big.md", huge);
    await settle([a, b]);
    expect(a.notices).toContainEqual({ kind: "file-too-large", path: "big.md" });
    expect(b.vault.files.has("big.md")).toBe(false);
    a.vault.externalWrite("big.md", "small now");
    await settle([a, b]);
    expect(b.vault.files.get("big.md")).toBe("small now");
  });

  // Review Focus 4
  it("treats a move into an excluded folder as a delete", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("note.md", "body");
    await settle([a, b]);
    a.vault.externalRename("note.md", ".trash/note.md");
    await settle([a, b]);
    expect(b.vault.files.has("note.md")).toBe(false);
    expect(b.vault.files.has(".trash/note.md")).toBe(false);
  });

  // Review Focus 5
  it("keeps a concurrent edit when the file is renamed elsewhere", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("draft.md", "first line\n");
    await settle([a, b]);
    a.vault.externalRename("draft.md", "final.md");
    b.vault.externalWrite("draft.md", "first line\nsecond line\n");
    await settle([a, b]);
    expect(a.vault.files.get("final.md")).toBe("first line\nsecond line\n");
    expect(b.vault.files.get("final.md")).toBe("first line\nsecond line\n");
    expect(b.vault.files.has("draft.md")).toBe(false);
  });
});

const ATTEMPTS = 10;

function snapshot(device: Device): Record<string, string> {
  return Object.fromEntries([...device.vault.files.entries()].sort());
}

describe("SyncEngine — chained and swapped moves", () => {
  it("applies a rename chain (a to b, c to a) without mixing file contents", async () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { hub, a, b } = await pair();
      a.vault.externalWrite("a.md", "alpha");
      a.vault.externalWrite("c.md", "gamma");
      a.vault.externalWrite("d.md", "delta");
      await settle([a, b]);
      const docs = ["a.md", "c.md", "d.md"].map((path) => fileDocName(a, path));
      a.vault.externalRename("a.md", "b.md");
      a.vault.externalRename("c.md", "a.md");
      await settle([a, b]);
      expect(snapshot(b)).toEqual(snapshot(a));
      expect(snapshot(b)).toEqual({ "a.md": "gamma", "b.md": "alpha", "d.md": "delta" });
      expect(docs.map((name) => hub.serverText(name))).toEqual(["alpha", "gamma", "delta"]);
      expect([...b.vault.files.keys()].some((path) => path.includes("(conflict"))).toBe(false);
    }
  });

  it("converges a swap done through a temporary name", async () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { a, b } = await pair();
      a.vault.externalWrite("a.md", "alpha");
      a.vault.externalWrite("b.md", "beta");
      await settle([a, b]);
      a.vault.externalRename("a.md", "tmp.md");
      a.vault.externalRename("b.md", "a.md");
      a.vault.externalRename("tmp.md", "b.md");
      await settle([a, b]);
      expect(snapshot(a)).toEqual({ "a.md": "beta", "b.md": "alpha" });
      expect(snapshot(b)).toEqual({ "a.md": "beta", "b.md": "alpha" });
    }
  });
});

describe("SyncEngine — stopping and size limits", () => {
  it("does not touch the vault after stop() when events were queued right before it", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("keep.md", "one");
    await settle([a, b]);
    const before = snapshot(b);
    b.vault.externalWrite("late.md", "queued");
    await Promise.resolve(); // event delivered, task queued
    await b.engine.stop();
    const afterStop = snapshot(b);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(snapshot(b)).toEqual(afterStop);
    expect(Object.keys(before)).toEqual(["keep.md"]);
  });

  it("stops syncing a tracked file that grows past the limit and resumes once it shrinks", async () => {
    const { hub, a, b } = await pair();
    a.vault.externalWrite("grow.md", "small");
    await settle([a, b]);
    a.vault.externalWrite("grow.md", "x".repeat(2 * 1024 * 1024 + 1));
    await settle([a, b]);
    expect(b.vault.files.get("grow.md")).toBe("small");
    expect(hub.serverText(fileDocName(a, "grow.md"))).toBe("small");
    expect(a.notices.filter((notice) => notice.kind === "file-too-large")).toHaveLength(1);
    a.vault.externalWrite("grow.md", "small again");
    await settle([a, b]);
    expect(b.vault.files.get("grow.md")).toBe("small again");
  });
});

