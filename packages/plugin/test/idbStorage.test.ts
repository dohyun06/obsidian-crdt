import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDB_OPEN_TIMEOUT_MS, openSyncDatabase, runRequest, STORE_RECORDS, StorageUnavailableError } from "../src/obsidian/idb";
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

  it("rejects with StorageUnavailableError when open fails", async () => {
    const mockFactory = {
      open: (_name: string, _version?: number) => {
        const req = Object.create(EventTarget.prototype) as IDBOpenDBRequest;
        Object.assign(req, {
          onerror: null as ((this: IDBOpenDBRequest, ev: Event) => unknown) | null,
          onsuccess: null as ((this: IDBOpenDBRequest, ev: Event) => unknown) | null,
          onupgradeneeded: null as ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null,
          onblocked: null as ((this: IDBOpenDBRequest, ev: Event) => unknown) | null,
          error: new Error("fake error") as unknown,
          result: null,
        });
        setTimeout(() => {
          if (req.onerror) req.onerror.call(req, new Event("error"));
        }, 0);
        return req;
      },
    } as IDBFactory;
    await expect(openSyncDatabase(DB, mockFactory)).rejects.toThrow(StorageUnavailableError);
  });

  it("rejects with StorageUnavailableError when open never completes", async () => {
    vi.useFakeTimers();
    const silentFactory = { open: () => ({}) as IDBOpenDBRequest } as unknown as IDBFactory;
    const opening = openSyncDatabase(DB, silentFactory);
    const assertion = expect(opening).rejects.toThrow(StorageUnavailableError);
    await vi.advanceTimersByTimeAsync(IDB_OPEN_TIMEOUT_MS - 1);
    let settled = false;
    void opening.catch(() => void (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("closes a database whose open completes only after the timeout", async () => {
    vi.useFakeTimers();
    const request = {} as IDBOpenDBRequest & { result: IDBDatabase };
    const closed = vi.fn();
    const slowFactory = { open: () => request } as unknown as IDBFactory;
    const opening = openSyncDatabase(DB, slowFactory);
    const assertion = expect(opening).rejects.toThrow(StorageUnavailableError);
    await vi.advanceTimersByTimeAsync(IDB_OPEN_TIMEOUT_MS);
    await assertion;
    Object.assign(request, { result: { close: closed } });
    request.onsuccess!.call(request, new Event("success"));
    expect(closed).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
