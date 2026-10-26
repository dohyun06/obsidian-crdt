import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildIndexDocName } from "@obsidian-crdt/shared";
import { createJsonLogger, createSyncServer, DocumentStore, openDatabase, TokenStore } from "@obsidian-crdt/server";
import { HocuspocusSyncer } from "../src/core/hocuspocusSyncer";
import type { SyncNotice } from "../src/core/notices";
import { EngineStoppedError, SyncEngine } from "../src/core/syncEngine";
import { FakeVault } from "./fakes/fakeVault";
import { FAST_TIMING, TEST_VAULT_ID } from "./fakes/device";
import { MemoryPersistence } from "./fakes/memoryPersistence";
import { MemoryStorage } from "./fakes/memoryStorage";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually(assertion: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function startServer() {
  const db = openDatabase(":memory:");
  const tokens = new TokenStore(db);
  const logs: string[] = [];
  const server = createSyncServer({
    port: 0,
    address: "127.0.0.1",
    documents: new DocumentStore(db),
    tokens,
    logger: createJsonLogger((line) => logs.push(line)),
    storeDebounceMs: 0,
  });
  await server.listen();
  cleanups.push(() => server.destroy());
  return { url: `ws://127.0.0.1:${server.address.port}`, token: tokens.issue(TEST_VAULT_ID).token, logs };
}

function device(url: string, token: string, files: Record<string, string> = {}) {
  const vault = new FakeVault(files);
  const notices: SyncNotice[] = [];
  let authFailures = 0;
  let engine: SyncEngine | null = null;
  const syncer = new HocuspocusSyncer({
    url,
    token,
    onAuthFailed: () => {
      authFailures++;
      void engine?.stop();
    },
  });
  engine = new SyncEngine({
    vaultId: TEST_VAULT_ID,
    vault,
    storage: new MemoryStorage(),
    syncer,
    persistence: new MemoryPersistence(),
    notify: (notice) => notices.push(notice),
    timing: FAST_TIMING,
  });
  const started = engine;
  cleanups.push(async () => {
    await started.stop();
    syncer.destroy();
  });
  return { vault, notices, syncer, engine: started, authFailures: () => authFailures };
}

describe("end to end with the real server", () => {
  it("syncs create, edit, rename and delete between two devices", async () => {
    const { url, token } = await startServer();
    const a = device(url, token, { "a.md": "hello" });
    const b = device(url, token);
    await a.engine.start();
    await b.engine.start();

    await eventually(() => expect(b.vault.files.get("a.md")).toBe("hello"));
    a.vault.externalWrite("a.md", "hello world");
    await eventually(() => expect(b.vault.files.get("a.md")).toBe("hello world"));
    b.vault.externalRename("a.md", "renamed.md");
    await eventually(() => expect([...a.vault.files.keys()]).toEqual(["renamed.md"]));
    a.vault.externalDelete("renamed.md");
    await eventually(() => expect(b.vault.files.size).toBe(0));
  });

  it("merges edits made while one device was disconnected", async () => {
    const { url, token } = await startServer();
    const a = device(url, token, { "a.md": "l1\nl2\n" });
    const b = device(url, token);
    await a.engine.start();
    await b.engine.start();
    await eventually(() => expect(b.vault.files.get("a.md")).toBe("l1\nl2\n"));

    a.syncer.pause();
    a.vault.externalWrite("a.md", "L1\nl2\n");
    b.vault.externalWrite("a.md", "l1\nl2\nfrom b\n");
    await a.engine.idle();
    a.syncer.resume();

    await eventually(() => {
      expect(a.vault.files.get("a.md")).toBe("L1\nl2\nfrom b\n");
      expect(b.vault.files.get("a.md")).toBe("L1\nl2\nfrom b\n");
    });
  });

  it("stops after an authentication failure and does not keep retrying", async () => {
    const { url, logs } = await startServer();
    const bad = device(url, "wrong-token");
    await expect(bad.engine.start()).rejects.toBeInstanceOf(EngineStoppedError);
    expect(bad.authFailures()).toBe(1);
    const rejectionsNow = logs.filter((line) => line.includes("auth.rejected")).length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(logs.filter((line) => line.includes("auth.rejected")).length).toBe(rejectionsNow);
  });

  it("publishes no presence for documents without a bound editor (regression: awareness renewal spam)", async () => {
    const { url, token } = await startServer();
    const syncer = new HocuspocusSyncer({ url, token, onAuthFailed: () => {} });
    cleanups.push(() => syncer.destroy());
    const handle = syncer.connect(buildIndexDocName(TEST_VAULT_ID), new Y.Doc());
    expect(handle.awareness?.getLocalState()).toBeNull();
    await handle.whenSynced();
    expect(handle.awareness?.getLocalState()).toBeNull();
  });
});
