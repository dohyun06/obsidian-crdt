import { describe, expect, it } from "vitest";
import type { VaultEvent } from "../src/core/ports";
import { FileNotFoundError, ObsidianVaultAdapter } from "../src/obsidian/vaultAdapter";
import { FakeObsidianVault } from "./fakes/fakeObsidianVault";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const vault = new FakeObsidianVault();
  return { vault, adapter: new ObsidianVaultAdapter(vault) };
}

describe("ObsidianVaultAdapter", () => {
  it("lists markdown files and reads files only", async () => {
    const { vault, adapter } = setup();
    vault.seed("notes/a.md", "A");
    vault.seed("img.png", "binary");
    expect(await adapter.listFiles()).toEqual(["notes/a.md"]);
    expect(await adapter.read("notes/a.md")).toBe("A");
    expect(await adapter.read("notes")).toBeNull();
    expect(await adapter.read("missing.md")).toBeNull();
  });

  it("creates files with missing parent folders and refuses existing ones", async () => {
    const { vault, adapter } = setup();
    expect(await adapter.replace("deep/er/new.md", null, "hi")).toBe(true);
    expect(vault.files.get("deep/er/new.md")?.data).toBe("hi");
    expect(await adapter.replace("deep/er/new.md", null, "again")).toBe(false);
  });

  it("writes only when the disk still holds the expected text", async () => {
    const { vault, adapter } = setup();
    vault.seed("a.md", "v1");
    expect(await adapter.replace("a.md", "stale", "v2")).toBe(false);
    expect(vault.files.get("a.md")?.data).toBe("v1");
    expect(await adapter.replace("a.md", "v1", "v2")).toBe(true);
    expect(vault.files.get("a.md")?.data).toBe("v2");
    expect(await adapter.replace("gone.md", "x", "y")).toBe(false);
  });

  it("propagates I/O failures instead of reporting a mismatch", async () => {
    const { vault, adapter } = setup();
    vault.seed("a.md", "v1");
    vault.create = async () => {
      throw new Error("disk full");
    };
    vault.process = async () => {
      throw new Error("disk full");
    };
    await expect(adapter.replace("new.md", null, "x")).rejects.toThrow("disk full");
    await expect(adapter.replace("a.md", "v1", "v2")).rejects.toThrow("disk full");
  });

  it("treats a create that lost a race to another writer as a mismatch", async () => {
    const { vault, adapter } = setup();
    vault.create = async (path: string) => {
      vault.seed(path, "other");
      throw new Error("File already exists.");
    };
    expect(await adapter.replace("raced.md", null, "mine")).toBe(false);
  });

  it("renames into new folders without link rewriting and fails on missing files", async () => {
    const { vault, adapter } = setup();
    vault.seed("a.md", "A");
    await adapter.rename("a.md", "x/y/b.md");
    expect(vault.files.get("x/y/b.md")?.data).toBe("A");
    await expect(adapter.rename("nope.md", "z.md")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("moves deletions to the vault trash", async () => {
    const { vault, adapter } = setup();
    vault.seed("a.md", "A");
    await adapter.trash("a.md");
    await adapter.trash("missing.md");
    expect(vault.trashed).toEqual([{ path: "a.md", system: false }]);
  });

  it("reports file events, ignores folder events and stops after unsubscribe", async () => {
    const { vault, adapter } = setup();
    const events: VaultEvent[] = [];
    const stop = adapter.onEvent((event) => events.push(event));
    await vault.createFolder("dir");
    await vault.create("dir/a.md", "A");
    vault.userModify("dir/a.md", "AA");
    await flush(); // the fake emits the live file object, so let the modify event fire before the rename moves it
    await vault.rename(vault.getAbstractFileByPath("dir/a.md")!, "dir/b.md");
    await vault.trash(vault.getAbstractFileByPath("dir/b.md")!, true);
    await flush();
    expect(events).toEqual([
      { type: "create", path: "dir/a.md" },
      { type: "modify", path: "dir/a.md" },
      { type: "rename", oldPath: "dir/a.md", path: "dir/b.md" },
      { type: "delete", path: "dir/b.md" },
    ]);
    stop();
    await vault.create("c.md", "C");
    await flush();
    expect(events).toHaveLength(4);
  });

  it("turns a folder rename into renames of the markdown files inside it", async () => {
    const { vault, adapter } = setup();
    vault.seed("old/a.md", "A");
    vault.seed("old/sub/b.md", "B");
    vault.seed("old/pic.png", "P");
    const events: VaultEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await vault.rename(vault.getAbstractFileByPath("old")!, "new");
    await flush();
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "rename", oldPath: "old/a.md", path: "new/a.md" },
        { type: "rename", oldPath: "old/sub/b.md", path: "new/sub/b.md" },
      ]),
    );
    expect(events).toHaveLength(2);
  });
});
