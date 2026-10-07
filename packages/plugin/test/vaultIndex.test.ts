import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { UnknownFileIdError, VaultIndex } from "../src/core/vaultIndex";

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ID_C = "cccccccc-0000-4000-8000-000000000003";
const CREATED = Date.UTC(2026, 9, 7, 9);

function idsFrom(...ids: string[]): () => string {
  const queue = [...ids];
  return () => {
    const next = queue.shift();
    if (!next) throw new Error("test ran out of ids");
    return next;
  };
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote");
}

describe("VaultIndex", () => {
  it("registers, renames and deletes entries", () => {
    const index = new VaultIndex(new Y.Doc(), idsFrom(ID_A));
    const id = index.register("notes/a.md", CREATED);
    expect(index.get(id)).toEqual({ fileId: ID_A, path: "notes/a.md", deleted: false, createdAt: CREATED });
    index.rename(id, "notes/b.md");
    expect(index.findLiveByPath("notes/b.md")?.fileId).toBe(ID_A);
    index.markDeleted(id);
    expect(index.findLiveByPath("notes/b.md")).toBeNull();
    expect(index.liveEntries()).toEqual([]);
  });

  it("throws for unknown ids", () => {
    expect(() => new VaultIndex(new Y.Doc()).rename(ID_A, "x.md")).toThrow(UnknownFileIdError);
  });

  it("notifies only for changes that did not originate locally", () => {
    const localDoc = new Y.Doc();
    const index = new VaultIndex(localDoc, idsFrom(ID_A));
    let calls = 0;
    index.onRemoteChange(() => calls++);
    index.register("a.md", CREATED);
    expect(calls).toBe(0);

    const otherDoc = new Y.Doc();
    new VaultIndex(otherDoc, idsFrom(ID_B)).register("b.md", CREATED);
    sync(otherDoc, localDoc);
    expect(calls).toBe(1);
  });

  it("plans the same collision resolution on every device", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    new VaultIndex(docA, idsFrom(ID_B)).register("Daily.md", CREATED);
    new VaultIndex(docB, idsFrom(ID_A)).register("Daily.md", CREATED);
    sync(docA, docB);
    sync(docB, docA);

    const planA = new VaultIndex(docA).planCollisionResolution();
    const planB = new VaultIndex(docB).planCollisionResolution();
    expect(planA).toEqual(planB);
    expect(planA).toEqual([{ fileId: ID_B, fromPath: "Daily.md", toPath: "Daily (conflict 2026-10-07 bbbbbb).md" }]);

    const indexA = new VaultIndex(docA);
    indexA.applyReassignments(planA);
    expect(indexA.findLiveByPath("Daily.md")?.fileId).toBe(ID_A);
    expect(indexA.planCollisionResolution()).toEqual([]);
  });

  it("ignores remote entries with unsafe paths or wrong types", () => {
    const doc = new Y.Doc();
    const files = doc.getMap<Y.Map<unknown>>("files");
    const evil = new Y.Map<unknown>();
    files.set(ID_A, evil);
    evil.set("path", "../../outside.md");
    evil.set("deleted", false);
    evil.set("createdAt", CREATED);
    const broken = new Y.Map<unknown>();
    files.set(ID_B, broken);
    broken.set("path", "ok.md");
    broken.set("deleted", "no");
    broken.set("createdAt", CREATED);
    const nanCreated = new Y.Map<unknown>();
    files.set(ID_C, nanCreated);
    nanCreated.set("path", "ok2.md");
    nanCreated.set("deleted", false);
    nanCreated.set("createdAt", NaN);
    expect(new VaultIndex(doc).entries()).toEqual([]);
  });
});
