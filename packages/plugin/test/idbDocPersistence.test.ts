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
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5 });
    const doc = new Y.Doc();
    const attached = await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "offline edit");
    attached.destroy();
    await persistence.flushAll();
    db.close();

    const reopened = await openSyncDatabase(DB, factory);
    const restored = new Y.Doc();
    await new IdbDocPersistence(reopened).attach(NAME, restored);
    expect(restored.getText("content").toString()).toBe("offline edit");
    reopened.close();
  });

  it("coalesces rapid updates into one write", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 50 });
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
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5 });
    await persistence.attach(NAME, new Y.Doc());
    await persistence.flushAll();
    expect(persistence.pendingWrites).toBe(0);
    db.close();
  });
});
