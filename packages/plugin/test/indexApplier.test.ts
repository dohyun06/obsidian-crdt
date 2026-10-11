import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { DocManager } from "../src/core/docManager";
import type { FileReconciler } from "../src/core/fileReconciler";
import { IndexApplier } from "../src/core/indexApplier";
import { RecordStore } from "../src/core/recordStore";
import { VaultIndex } from "../src/core/vaultIndex";
import { FakeVault } from "./fakes/fakeVault";
import { MemoryStorage } from "./fakes/memoryStorage";

const NOTE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const CREATED_AT = Date.UTC(2026, 9, 7, 12);

class FailingRenameVault extends FakeVault {
  override async rename(): Promise<void> {
    throw new Error("rename failed: disk error");
  }
}

/** Index entries in `targets` (fileId → index path); records in `records` (fileId → device path). */
async function setup(vault: FakeVault, targets: Record<string, string>, records: Record<string, string>) {
  const ids = Object.keys(targets);
  const index = new VaultIndex(new Y.Doc(), () => ids.shift()!);
  for (const path of Object.values(targets)) index.register(path, CREATED_AT);
  const store = await RecordStore.load(new MemoryStorage());
  for (const [fileId, path] of Object.entries(records)) await store.set(fileId, { path, base: vault.files.get(path) ?? null });
  const applier = new IndexApplier({
    vault,
    index,
    records: store,
    docs: {} as DocManager, // every entry already has a record: no creation opens a doc
    reconciler: {} as FileReconciler,
    isEligible: () => true,
    requestPass: () => {},
  });
  return { applier, store };
}

describe("IndexApplier case-only moves on a case-sensitive vault (regression: record pointed at another note)", () => {
  it("defers a case-only move when a different file already sits at the exact target spelling", async () => {
    const vault = new FakeVault({ "Note.md": "mine", "note.md": "someone else" });
    const { applier, store } = await setup(vault, { [NOTE_ID]: "note.md" }, { [NOTE_ID]: "Note.md" });
    await applier.apply();
    expect(store.get(NOTE_ID)).toEqual({ path: "Note.md", base: "mine" });
    expect(Object.fromEntries(vault.files)).toEqual({ "Note.md": "mine", "note.md": "someone else" });
  });

  it("still performs a case-only move when the exact target spelling is free", async () => {
    const vault = new FakeVault({ "Note.md": "mine" });
    const { applier, store } = await setup(vault, { [NOTE_ID]: "note.md" }, { [NOTE_ID]: "Note.md" });
    await applier.apply();
    expect(store.get(NOTE_ID)).toEqual({ path: "note.md", base: "mine" });
    expect(Object.fromEntries(vault.files)).toEqual({ "note.md": "mine" });
  });
});

describe("IndexApplier restores the record when a rename fails", () => {
  it("restores the record of a move and rethrows", async () => {
    const vault = new FailingRenameVault({ "a.md": "body" });
    const { applier, store } = await setup(vault, { [NOTE_ID]: "b.md" }, { [NOTE_ID]: "a.md" });
    await expect(applier.apply()).rejects.toThrow("rename failed: disk error");
    expect(store.get(NOTE_ID)).toEqual({ path: "a.md", base: "body" });
    expect(store.findIdByPath("b.md")).toBeNull();
  });

  it("restores the record of a move aside (swap) and rethrows", async () => {
    const vault = new FailingRenameVault({ "a.md": "A", "b.md": "B" });
    const { applier, store } = await setup(vault, { [NOTE_ID]: "b.md", [OTHER_ID]: "a.md" }, { [NOTE_ID]: "a.md", [OTHER_ID]: "b.md" });
    await expect(applier.apply()).rejects.toThrow("rename failed: disk error");
    expect(store.get(NOTE_ID)).toEqual({ path: "a.md", base: "A" });
    expect(store.get(OTHER_ID)).toEqual({ path: "b.md", base: "B" });
    expect(store.findIdByPath("a.md")).toBe(NOTE_ID);
  });
});
