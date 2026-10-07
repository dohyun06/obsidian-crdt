import { describe, expect, it } from "vitest";
import { DocManager } from "../src/core/docManager";
import { TextHistory } from "../src/core/textHistory";
import { FileReconciler } from "../src/core/fileReconciler";
import type { SyncNotice } from "../src/core/notices";
import { RecordStore } from "../src/core/recordStore";
import { FakeVault } from "./fakes/fakeVault";
import { LoopbackHub, LoopbackSyncer } from "./fakes/loopback";
import { MemoryPersistence } from "./fakes/memoryPersistence";
import { MemoryStorage } from "./fakes/memoryStorage";

const VAULT = "test-vault-01";
const FILE = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";
const NOW = Date.UTC(2026, 9, 7, 12);

async function setup(options: { files?: Record<string, string>; online?: boolean; hub?: LoopbackHub } = {}) {
  const hub = options.hub ?? new LoopbackHub();
  const vault = new FakeVault(options.files ?? {});
  const syncer = new LoopbackSyncer(hub, { online: options.online ?? true });
  const records = await RecordStore.load(new MemoryStorage());
  const docs = new DocManager({ vaultId: VAULT, syncer, persistence: new MemoryPersistence(), onTextChanged: () => {} });
  const notices: SyncNotice[] = [];
  const retries: string[] = [];
  const reconciler = new FileReconciler({
    vault,
    records,
    docs,
    now: () => NOW,
    history: new TextHistory(),
    notify: (notice) => notices.push(notice),
    requestRetry: (fileId) => retries.push(fileId),
  });
  return { hub, vault, syncer, records, docs, reconciler, notices, retries };
}

describe("FileReconciler", () => {
  it("writes remote text to disk when the disk did not change", async () => {
    const t = await setup({ files: { "a.md": "v1" } });
    await t.records.set(FILE, { path: "a.md", base: "v1" });
    (await t.docs.open(FILE)).text.insert(0, "v1");
    (await t.docs.open(FILE)).text.insert(2, " + phone");
    await t.reconciler.reconcile(FILE);
    expect(t.vault.files.get("a.md")).toBe("v1 + phone");
    expect(t.records.get(FILE)).toEqual({ path: "a.md", base: "v1 + phone" });
  });

  it("merges an outside disk edit with a concurrent remote edit", async () => {
    const t = await setup({ files: { "a.md": "A\nb\n" } });
    await t.records.set(FILE, { path: "a.md", base: "a\nb\n" });
    (await t.docs.open(FILE)).text.insert(0, "a\nb\nc\n");
    await t.reconciler.reconcile(FILE);
    expect(t.vault.files.get("a.md")).toBe("A\nb\nc\n");
    expect(t.hub.serverText(`${VAULT}/${FILE}`)).toBe("A\nb\nc\n");
  });

  it("does nothing on the modify event caused by its own write (regression: self-write)", async () => {
    const t = await setup({ files: { "a.md": "v1" } });
    await t.records.set(FILE, { path: "a.md", base: "v1" });
    const opened = await t.docs.open(FILE);
    opened.text.insert(0, "v2");
    await t.reconciler.reconcile(FILE);
    let updates = 0;
    opened.doc.on("update", () => updates++);
    await t.reconciler.reconcile(FILE);
    expect(updates).toBe(0);
    expect(t.vault.files.get("a.md")).toBe("v2");
  });

  it("keeps the server text and saves a disk copy on bootstrap conflicts", async () => {
    const hub = new LoopbackHub();
    hub.serverDoc(`${VAULT}/${FILE}`).getText("content").insert(0, "server");
    const t = await setup({ hub, files: { "a.md": "stale" } });
    await t.records.set(FILE, { path: "a.md", base: null });
    await t.reconciler.reconcile(FILE);
    expect(t.vault.files.get("a.md")).toBe("server");
    expect(t.vault.files.get("a (conflict-disk 2026-10-07 3f2b8c).md")).toBe("stale");
    expect(t.notices).toEqual([{ kind: "conflict-copy", path: "a.md", copyPath: "a (conflict-disk 2026-10-07 3f2b8c).md" }]);
  });

  it("waits for the server before reconciling a file with no base (regression: bootstrap doubling)", async () => {
    const hub = new LoopbackHub();
    hub.serverDoc(`${VAULT}/${FILE}`).getText("content").insert(0, "hello");
    const t = await setup({ hub, files: { "a.md": "hello" }, online: false });
    await t.records.set(FILE, { path: "a.md", base: null });
    await t.reconciler.reconcile(FILE); // offline: must not block the caller
    expect(hub.serverText(`${VAULT}/${FILE}`)).toBe("hello");
    expect(t.vault.files.get("a.md")).toBe("hello");
    expect((await t.docs.open(FILE)).text.toString()).toBe("");
    expect(t.retries).toEqual([]);
    t.syncer.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.retries).toEqual([FILE]);
    await t.reconciler.reconcile(FILE);
    expect(hub.serverText(`${VAULT}/${FILE}`)).toBe("hello");
    expect(t.vault.files.get("a.md")).toBe("hello");
  });

  it("asks for a retry when the disk changes between read and write", async () => {
    const t = await setup({ files: { "a.md": "v1" } });
    await t.records.set(FILE, { path: "a.md", base: "v1" });
    (await t.docs.open(FILE)).text.insert(0, "v2");
    const originalRead = t.vault.read.bind(t.vault);
    t.vault.read = async (path) => {
      const value = await originalRead(path);
      t.vault.files.set(path, "changed underneath");
      return value;
    };
    await t.reconciler.reconcile(FILE);
    expect(t.retries).toEqual([FILE]);
    expect(t.vault.files.get("a.md")).toBe("changed underneath");
  });

  it("never loses disk text when the copy path is taken between lookup and write", async () => {
    const hub = new LoopbackHub();
    hub.serverDoc(`${VAULT}/${FILE}`).getText("content").insert(0, "server");
    const t = await setup({ hub, files: { "a.md": "stale" } });
    await t.records.set(FILE, { path: "a.md", base: null });
    const copy = "a (conflict-disk 2026-10-07 3f2b8c).md";
    const originalRead = t.vault.read.bind(t.vault);
    let raced = false;
    t.vault.read = async (path) => {
      const value = await originalRead(path);
      if (path === copy && value === null && !raced) {
        raced = true;
        t.vault.files.set(copy, "someone else");
      }
      return value;
    };
    await t.reconciler.reconcile(FILE);
    expect(t.vault.files.get(copy)).toBe("someone else");
    expect(t.vault.files.get("a (conflict-disk 2026-10-07 3f2b8c) 2.md")).toBe("stale");
    expect(t.vault.files.get("a.md")).toBe("server");
    expect(t.notices).toEqual([{ kind: "conflict-copy", path: "a.md", copyPath: "a (conflict-disk 2026-10-07 3f2b8c) 2.md" }]);
  });

  it("creates exactly one disk copy when the main write fails and is retried", async () => {
    const hub = new LoopbackHub();
    hub.serverDoc(`${VAULT}/${FILE}`).getText("content").insert(0, "server");
    const t = await setup({ hub, files: { "a.md": "stale" } });
    await t.records.set(FILE, { path: "a.md", base: null });
    const originalReplace = t.vault.replace.bind(t.vault);
    let failed = false;
    t.vault.replace = async (path, expected, next) => {
      if (path === "a.md" && !failed) {
        failed = true;
        return false;
      }
      return originalReplace(path, expected, next);
    };
    await t.reconciler.reconcile(FILE);
    expect(t.retries).toEqual([FILE]);
    await t.reconciler.reconcile(FILE);
    const copies = [...t.vault.files.keys()].filter((path) => path.includes("conflict-disk"));
    expect(copies).toHaveLength(1);
    expect(t.vault.files.get(copies[0] as string)).toBe("stale");
    expect(t.vault.files.get("a.md")).toBe("server");
    expect(t.notices).toHaveLength(1);
  });
});
