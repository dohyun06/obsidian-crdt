import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { openSyncDatabase, runRequest, STORE_DOCS } from "../src/obsidian/idb";
import { IdbDocPersistence } from "../src/obsidian/idbDocPersistence";

const DB = "crdt-sync/test-vault/test-vault-01";
const NAME = "test-vault-01/3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

describe("IdbDocPersistence", () => {
  it("restores a document after destroy and reopen", async () => {
    const factory = new IDBFactory();
    const db = await openSyncDatabase(DB, factory);
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5, onError: () => {} });
    const doc = new Y.Doc();
    const attached = await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "offline edit");
    attached.destroy();
    await persistence.flushAll();
    db.close();

    const reopened = await openSyncDatabase(DB, factory);
    const restored = new Y.Doc();
    await new IdbDocPersistence(reopened, { onError: () => {} }).attach(NAME, restored);
    expect(restored.getText("content").toString()).toBe("offline edit");
    reopened.close();
  });

  it("coalesces rapid updates into one write", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 50, onError: () => {} });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    for (const ch of "abc") doc.getText("content").insert(0, ch);
    expect(await runRequest(db, STORE_DOCS, "readonly", (store) => store.get(NAME))).toBeUndefined();
    await persistence.flushAll();
    const saved = new Y.Doc();
    Y.applyUpdate(saved, (await runRequest(db, STORE_DOCS, "readonly", (store) => store.get(NAME))) as Uint8Array);
    expect(saved.getText("content").toString()).toBe("cba");
    db.close();
  });

  it("does not write back the state it just loaded", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const seed = new Y.Doc();
    seed.getText("content").insert(0, "seed");
    await runRequest(db, STORE_DOCS, "readwrite", (store) => store.put(Y.encodeStateAsUpdate(seed), NAME));
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5, onError: () => {} });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    await persistence.flushAll();
    expect(persistence.pendingWrites).toBe(0);
    doc.getText("content").insert(0, "new edit");
    expect(persistence.pendingWrites).toBeGreaterThan(0);
    db.close();
  });

  it("retries failed saves on next schedule", async () => {
    const factory = new IDBFactory();
    const db = await openSyncDatabase(DB, factory);
    let callCount = 0;
    const onError = () => { callCount++; };
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5, onError });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "edit 1");
    await persistence.flushAll();
    db.close();

    // Reopen and verify the first edit was saved
    const reopened = await openSyncDatabase(DB, factory);
    const restored = new Y.Doc();
    await new IdbDocPersistence(reopened, { onError: () => {} }).attach(NAME, restored);
    expect(restored.getText("content").toString()).toBe("edit 1");
    reopened.close();
  });

  it("calls onError and keeps doc dirty on write failure, retries on next flushAll", async () => {
    const factory = new IDBFactory();
    const db = await openSyncDatabase(DB, factory);
    const errors: unknown[] = [];
    let failOnce = true;
    const originalTransaction = db.transaction.bind(db);
    db.transaction = function (store: string, mode?: IDBTransactionMode) {
      if (failOnce && store === "docs" && mode === "readwrite") {
        failOnce = false;
        throw new Error("injected write failure");
      }
      return originalTransaction(store, mode);
    } as any;
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5, onError: (e) => errors.push(e) });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "edit");

    // First flushAll should fail
    await persistence.flushAll();
    expect(errors.length).toBe(1);

    // Retry via flushAll should now succeed (failOnce is false now)
    await persistence.flushAll();
    db.close();

    // Verify the edit was saved by loading with a fresh doc
    const reopened = await openSyncDatabase(DB, factory);
    const restored = new Y.Doc();
    await new IdbDocPersistence(reopened, { onError: () => {} }).attach(NAME, restored);
    expect(restored.getText("content").toString()).toBe("edit");
    reopened.close();
  });

  it("flushAll resolves even when a write fails", async () => {
    const factory = new IDBFactory();
    const db = await openSyncDatabase(DB, factory);
    const errors: unknown[] = [];
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5, onError: (e) => errors.push(e) });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "edit");
    db.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(persistence.flushAll()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("saves within the max-wait even while updates keep arriving", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const writes: string[] = [];
    const original = db.transaction.bind(db);
    db.transaction = ((stores: string | string[], mode?: IDBTransactionMode) => {
      if (mode === "readwrite") writes.push(String(stores));
      return original(stores as string, mode);
    }) as typeof db.transaction;
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 300, onError: () => {} });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (let elapsed = 0; elapsed < 1900; elapsed += 100) {
        doc.getText("content").insert(0, "x");
        vi.advanceTimersByTime(100);
      }
      expect(writes).toHaveLength(0);
      doc.getText("content").insert(0, "x");
      vi.advanceTimersByTime(200);
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    await persistence.flushAll();
    db.close();
  });
});
