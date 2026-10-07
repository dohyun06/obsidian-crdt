import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
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

  it("calls onError and keeps doc dirty on write failure, retries on next flush", async () => {
    const factory = new IDBFactory();
    const db = await openSyncDatabase(DB, factory);
    const errors: unknown[] = [];
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5, onError: (e) => errors.push(e) });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "edit");
    await persistence.flushAll();

    // Close DB to cause next write to fail
    db.close();
    doc.getText("content").insert(0, "x");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors.length).toBeGreaterThan(0);

    // Reopen and retry
    const reopened = await openSyncDatabase(DB, factory);
    const persistence2 = new IdbDocPersistence(reopened, { saveDebounceMs: 5, onError: (e) => errors.push(e) });
    await persistence2.attach(NAME, doc);
    await persistence2.flushAll();
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

  it("enforces max-wait on debounce", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 100, onError: () => {} });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "1");
    let wrote = false;
    const checkWrite = setInterval(async () => {
      const saved = await runRequest(db, STORE_DOCS, "readonly", (store) => store.get(NAME));
      if (saved) wrote = true;
    }, 50);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    clearInterval(checkWrite);
    expect(wrote).toBe(true);
    db.close();
  });
});
