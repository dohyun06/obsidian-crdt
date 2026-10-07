import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "../src/core/syncEngine";
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
  paused = false;
  pause(): void {
    this.paused = true;
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
  const counts = { authFailed: 0 };
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
    onAuthFailed: () => void (counts.authFailed += 1),
    timing: FAST_TIMING,
    ...overrides,
  });
  sessions.push(session);
  return { session, vault, statuses, notices, log, counts, syncer: () => syncer!, failAuth: () => authFailed!() };
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

  it("passes content-free debug events from the engine to the owner", async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const a = makeSession(new LoopbackHub(), { debug: (event, fields) => events.push({ event, fields }) });
    await a.session.start();
    a.vault.externalWrite("n.md", "secret note text");
    await settleAll();
    expect(events).toContainEqual({ event: "vault-event", fields: { kind: "create", path: "n.md" } });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("stops by flushing storage, closing it and destroying the syncer", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    await a.session.stop();
    expect(a.log).toEqual(["flush", "close"]);
    expect(a.syncer().destroyed).toBe(true);
    expect(a.session.status).toBe("stopped");
  });

  it("reports an authentication failure, pauses the syncer and leaves stopping to the owner", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    a.failAuth();
    await settleAll();
    expect(a.session.status).toBe("auth-failed");
    expect(a.syncer().paused).toBe(true);
    expect(a.counts.authFailed).toBe(1);
    expect(a.session.editorSource).not.toBeNull();
    a.session.resume();
    expect(a.syncer().paused).toBe(true);
    await a.session.stop();
    expect(a.session.status).toBe("auth-failed");
    expect(a.session.editorSource).toBeNull();
  });

  it("releases everything and reports error when storage cannot be opened", async () => {
    const a = makeSession(new LoopbackHub(), {
      openStorage: async () => {
        throw new Error("idb down");
      },
    });
    await expect(a.session.start()).rejects.toThrow("idb down");
    expect(a.session.status).toBe("error");
    expect(a.session.editorSource).toBeNull();
  });

  it("releases storage and syncer and reports error when the engine fails to start", async () => {
    const log: string[] = [];
    const storage = new MemoryStorage();
    storage.setFlag = async () => {
      throw new Error("flag write failed");
    };
    const a = makeSession(new LoopbackHub(), {
      openStorage: async () => ({ storage, persistence: new MemoryPersistence(), flush: async () => void log.push("flush"), close: () => void log.push("close") }),
    });
    await expect(a.session.start()).rejects.toThrow("flag write failed");
    expect(a.session.status).toBe("error");
    expect(log).toEqual(["flush", "close"]);
    expect(a.syncer().destroyed).toBe(true);
    expect(a.session.editorSource).toBeNull();
  });

  it("stop is idempotent: concurrent calls release once and resolve together", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    await Promise.all([a.session.stop(), a.session.stop()]);
    expect(a.log).toEqual(["flush", "close"]);
    await a.session.stop();
    expect(a.log).toEqual(["flush", "close"]);
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
    expect(a.session.pausedDeletePaths.length).toBe(5);
    await a.session.restoreDeletes();
    expect(a.session.status).toBe("connected");
    expect(a.session.pausedDeletePaths).toEqual([]);
  });

  // Fresh device whose server is unreachable: the start waits for a first sync.
  const offlineSyncer = (hub: LoopbackHub, capture: { syncer?: TestSyncer; failAuth?: () => void }) =>
    (_config: unknown, handlers: { onAuthFailed(): void }) => {
      capture.syncer = new TestSyncer(hub, { online: false });
      capture.failAuth = handlers.onAuthFailed;
      return capture.syncer;
    };

  it("auth failure while waiting for the first sync stops the start without the owner", async () => {
    const capture: { syncer?: TestSyncer; failAuth?: () => void } = {};
    const a = makeSession(new LoopbackHub(), { createSyncer: offlineSyncer(new LoopbackHub(), capture) as SessionDeps["createSyncer"] });
    const starting = a.session.start();
    await settleAll();
    expect(a.session.status).toBe("waiting-first-sync");
    expect(a.session.isStarting).toBe(true);
    capture.failAuth!();
    await starting;
    expect(a.session.status).toBe("auth-failed");
    expect(a.counts.authFailed).toBe(0);
    expect(capture.syncer!.destroyed).toBe(true);
    expect(a.log).toEqual(["flush", "close"]);
  });

  it("stop while waiting for the first sync lets start return and releases everything", async () => {
    const capture: { syncer?: TestSyncer } = {};
    const a = makeSession(new LoopbackHub(), { createSyncer: offlineSyncer(new LoopbackHub(), capture) as SessionDeps["createSyncer"] });
    const starting = a.session.start();
    await settleAll();
    await a.session.stop();
    await starting;
    expect(a.session.status).toBe("stopped");
    expect(capture.syncer!.destroyed).toBe(true);
    expect(a.log).toEqual(["flush", "close"]);
  });

  it("applies a pause requested before the syncer exists", async () => {
    const a = makeSession(new LoopbackHub());
    a.session.pause();
    const starting = a.session.start(); // a paused fresh device keeps waiting for its first sync
    await settleAll();
    expect(a.syncer().paused).toBe(true);
    await a.session.stop();
    await starting;
  });

  it("still closes storage and destroys the syncer when the engine fails to stop, and a later stop retries", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    const spy = vi.spyOn(SyncEngine.prototype, "stop").mockRejectedValueOnce(new Error("engine stuck"));
    await expect(a.session.stop()).rejects.toThrow("engine stuck");
    expect(a.log).toEqual(["flush", "close"]);
    expect(a.syncer().destroyed).toBe(true);
    await a.session.stop();
    expect(a.session.status).toBe("stopped");
    spy.mockRestore();
  });
});
