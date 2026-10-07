import { describe, expect, it } from "vitest";
import { RecordStore } from "../src/core/recordStore";
import { MemoryStorage } from "./fakes/memoryStorage";

describe("RecordStore", () => {
  it("indexes records by path and follows renames", async () => {
    const storage = new MemoryStorage();
    const records = await RecordStore.load(storage);
    await records.set("id-1", { path: "a.md", base: "x" });
    await records.set("id-1", { path: "b.md", base: "x" });
    expect(records.findIdByPath("a.md")).toBeNull();
    expect(records.findIdByPath("b.md")).toBe("id-1");
    expect(storage.records.get("id-1")).toEqual({ path: "b.md", base: "x" });
  });

  it("reloads persisted records", async () => {
    const storage = new MemoryStorage();
    await (await RecordStore.load(storage)).set("id-1", { path: "a.md", base: null });
    const reloaded = await RecordStore.load(storage);
    expect(reloaded.get("id-1")).toEqual({ path: "a.md", base: null });
  });

  it("deletes records", async () => {
    const records = await RecordStore.load(new MemoryStorage());
    await records.set("id-1", { path: "a.md", base: "x" });
    await records.delete("id-1");
    expect(records.get("id-1")).toBeNull();
    expect(records.findIdByPath("a.md")).toBeNull();
  });
});
