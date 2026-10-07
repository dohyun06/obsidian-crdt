import { afterEach, describe, expect, it } from "vitest";
import type { SyncNotice } from "../src/core/notices";
import { type SessionDeps, type SessionSyncer, SyncSession } from "../src/session/syncSession";
import type { SyncStatus } from "../src/session/status";
import { FAST_TIMING, TEST_VAULT_ID } from "./fakes/device";
import { FakeVault } from "./fakes/fakeVault";
import { LoopbackHub, LoopbackSyncer } from "./fakes/loopback";
import { MemoryPersistence } from "./fakes/memoryPersistence";
import { MemoryStorage } from "./fakes/memoryStorage";

const CONFIG = { serverUrl: "wss://example.test", vaultId: TEST_VAULT_ID, token: "t", deviceName: "A" };
const sessions: SyncSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
});

class TestSyncer extends LoopbackSyncer implements SessionSyncer {
  destroyed = false;
  pause(): void {
    this.setOnline(false);
  }
  resume(): void {
    this.setOnline(true);
  }
  destroy(): void {
    this.destroyed = true;
    this.setOnline(false);
  }
}

function makeSession(hub: LoopbackHub, overrides: Partial<SessionDeps> = {}) {
  const statuses: SyncStatus[] = [];
  const notices: SyncNotice[] = [];
  const vault = new FakeVault();
  const log: string[] = [];
  let syncer: TestSyncer | null = null;
  let authFailed: (() => void) | null = null;
  const session = new SyncSession({
    config: CONFIG,
    vault,
    openStorage: async () => ({
      storage: new MemoryStorage(),
      persistence: new MemoryPersistence(),
      flush: async () => void log.push("flush"),
      close: () => void log.push("close"),
    }),
    createSyncer: (_config, handlers) => {
      syncer = new TestSyncer(hub);
      authFailed = handlers.onAuthFailed;
      return syncer;
    },
    isOpenInEditor: () => false,
    excludedPrefixes: [".obsidian/"],
    onStatus: (status) => statuses.push(status),
    onNotice: (notice) => notices.push(notice),
    timing: FAST_TIMING,
    ...overrides,
  });
  sessions.push(session);
  return { session, vault, statuses, notices, log, syncer: () => syncer!, failAuth: () => authFailed!() };
}

const settleAll = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("SyncSession", () => {
  it("starts, syncs files between two sessions and reports connected", async () => {
    const hub = new LoopbackHub();
    const a = makeSession(hub);
    const b = makeSession(hub);
    await a.session.start();
    await b.session.start();
    a.vault.externalWrite("n.md", "hi");
    await settleAll();
    expect(b.vault.files.get("n.md")).toBe("hi");
    expect(a.statuses).toEqual(["starting", "connected"]);
  });

  it("stops by flushing storage, closing it and destroying the syncer", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    await a.session.stop();
    expect(a.log).toEqual(["flush", "close"]);
    expect(a.syncer().destroyed).toBe(true);
    expect(a.session.status).toBe("stopped");
  });

  it("reports an authentication failure and stops the engine", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    a.failAuth();
    await settleAll();
    expect(a.session.status).toBe("auth-failed");
    expect(a.session.editorSource).toBeNull();
  });

  // Review Focus 5
  it("stop during start releases everything", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const log: string[] = [];
    const a = makeSession(new LoopbackHub(), {
      openStorage: async () => {
        await gate;
        return { storage: new MemoryStorage(), persistence: new MemoryPersistence(), flush: async () => void log.push("flush"), close: () => void log.push("close") };
      },
    });
    const starting = a.session.start();
    const stopping = a.session.stop();
    release();
    await expect(starting).resolves.toBeUndefined();
    await stopping;
    expect(log).toEqual(["close"]);
    expect(a.session.status).toBe("stopped");
  });

  // Review Focus 4 (session half; the plugin restarts by stop() then a new session)
  it("restarting stops the old session before starting the new one", async () => {
    const hub = new LoopbackHub();
    const first = makeSession(hub);
    await first.session.start();
    await first.session.stop();
    const second = makeSession(hub, { vault: first.vault });
    await second.session.start();
    first.vault.externalWrite("after.md", "x");
    await settleAll();
    expect(first.syncer().destroyed).toBe(true);
    expect(hub.serverDoc(`${TEST_VAULT_ID}/index`).getMap("files").size).toBe(1);
  });

  it("enters deletes-paused on a mass delete and leaves it after a decision", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    for (const name of ["1", "2", "3", "4", "5"]) a.vault.externalWrite(`${name}.md`, name);
    await settleAll();
    for (const name of ["1", "2", "3", "4", "5"]) a.vault.externalDelete(`${name}.md`);
    await settleAll();
    expect(a.session.status).toBe("deletes-paused");
    await a.session.restoreDeletes();
    expect(a.session.status).toBe("connected");
  });
});
