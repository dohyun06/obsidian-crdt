import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { openSyncDatabase, runRequest, STORE_RECORDS } from "../src/obsidian/idb";
import { IdbStorage } from "../src/obsidian/idbStorage";

const DB = "crdt-sync/test-vault/test-vault-01";

describe("IdbStorage", () => {
  it("saves, reloads and deletes records across connections", async () => {
    const factory = new IDBFactory();
    const first = await openSyncDatabase(DB, factory);
    const storage = new IdbStorage(first);
    await storage.saveRecord("id-1", { path: "a.md", base: "x" });
    await storage.saveRecord("id-2", { path: "b.md", base: null });
    await storage.deleteRecord("id-2");
    first.close();
    const second = await openSyncDatabase(DB, factory);
    expect(await new IdbStorage(second).loadRecords()).toEqual([["id-1", { path: "a.md", base: "x" }]]);
    second.close();
  });

  it("stores flags", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const storage = new IdbStorage(db);
    expect(await storage.getFlag("bootstrapped")).toBe(false);
    await storage.setFlag("bootstrapped", true);
    expect(await storage.getFlag("bootstrapped")).toBe(true);
    db.close();
  });

  it("skips malformed records instead of failing the load", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    await runRequest(db, STORE_RECORDS, "readwrite", (store) => store.put({ fileId: "bad", path: 42, base: null }, "bad"));
    await new IdbStorage(db).saveRecord("good", { path: "g.md", base: "g" });
    expect(await new IdbStorage(db).loadRecords()).toEqual([["good", { path: "g.md", base: "g" }]]);
    db.close();
  });
});
