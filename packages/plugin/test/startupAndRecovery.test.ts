import { afterEach, describe, expect, it } from "vitest";
import { EngineStoppedError } from "../src/core/syncEngine";
import { LoopbackHub } from "./fakes/loopback";
import { createDevice, type Device, fileDocName, restartDevice, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function start(hub: LoopbackHub, name: string, files: Record<string, string> = {}): Promise<Device> {
  const device = await startDevice(hub, name, { files });
  running.push(device);
  return device;
}

describe("startup scan and bootstrap", () => {
  it("registers files that already exist on the first device", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "hello" });
    await settle([a]);
    expect(hub.serverText(fileDocName(a, "a.md"))).toBe("hello");
  });

  it("does not double text when a second device already has the same file (regression: bootstrap doubling)", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "hello" });
    await settle([a]);
    const b = await start(hub, "B", { "a.md": "hello" });
    await settle([a, b]);
    expect(hub.serverText(fileDocName(a, "a.md"))).toBe("hello");
    expect(b.vault.files.get("a.md")).toBe("hello");
    expect(fileDocName(b, "a.md")).toBe(fileDocName(a, "a.md"));
    expect(b.notices.filter((notice) => notice.kind === "conflict-copy")).toEqual([]);
  });

  it("keeps the server text and saves a copy when a new device has a stale file", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "new" });
    await settle([a]);
    const b = await start(hub, "B", { "a.md": "old" });
    await settle([a, b]);
    expect(b.vault.files.get("a.md")).toBe("new");
    expect(b.vault.files.get("a (conflict-disk 2026-10-07 " + fileDocName(a, "a.md").split("/")[1]!.slice(0, 6) + ").md")).toBe("old");
    expect(hub.serverText(fileDocName(a, "a.md"))).toBe("new");
  });

  it("waits for the server on the very first start", async () => {
    const hub = new LoopbackHub();
    const device = createDevice(hub, "A", { online: false });
    running.push(device);
    let started = false;
    const starting = device.engine.start().then(() => (started = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(false);
    expect(device.notices).toContainEqual({ kind: "waiting-for-first-sync" });
    device.syncer.setOnline(true);
    await starting;
  });

  it("rejects start with EngineStoppedError when stopped while waiting", async () => {
    const device = createDevice(new LoopbackHub(), "A", { online: false });
    const starting = device.engine.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await device.engine.stop();
    await expect(starting).rejects.toBeInstanceOf(EngineStoppedError);
  });

  it("starts offline after the first sync and catches up later", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "v1" });
    await settle([a]);
    const restarted = await restartDevice(hub, a, { online: false });
    running.splice(running.indexOf(a), 1, restarted);
    restarted.vault.externalWrite("a.md", "v1 offline edit");
    await settle([restarted]);
    restarted.syncer.setOnline(true);
    await settle([restarted]);
    expect(hub.serverText(fileDocName(restarted, "a.md"))).toBe("v1 offline edit");
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("stopping while start() is still running (regression: start/stop leak)", () => {
  it("tears down when stopped while documents are being loaded", async () => {
    const device = createDevice(new LoopbackHub(), "A");
    const attach = device.persistence.attach.bind(device.persistence);
    device.persistence.attach = async (docName, doc) => {
      await delay(30);
      return attach(docName, doc);
    };
    const starting = device.engine.start();
    await delay(5);
    await device.engine.stop();
    await expect(starting).rejects.toBeInstanceOf(EngineStoppedError);
    expect(device.syncer.linkCount).toBe(0);
    expect(device.vault.listenerCount).toBe(0);
  });

  it("registers no listeners when stopped after the bootstrap flag was read", async () => {
    const hub = new LoopbackHub();
    const first = await start(hub, "A", { "a.md": "v1" });
    await first.engine.stop();
    running.splice(running.indexOf(first), 1);
    const device = createDevice(hub, "A", { reuse: first });
    const getFlag = device.storage.getFlag.bind(device.storage);
    device.storage.getFlag = async (key) => {
      await delay(30);
      return getFlag(key);
    };
    const starting = device.engine.start();
    await delay(5);
    await device.engine.stop();
    await expect(starting).rejects.toBeInstanceOf(EngineStoppedError);
    expect(device.syncer.linkCount).toBe(0);
    expect(device.vault.listenerCount).toBe(0);
  });
});

describe("startup failure isolation and interruption", () => {
  it("keeps scanning when one file fails to read", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "remote.md": "from A" });
    await settle([a]);
    const b = createDevice(hub, "B", { files: { "bad.md": "x", "good.md": "ok" } });
    running.push(b);
    const read = b.vault.read.bind(b.vault);
    b.vault.read = async (path) => {
      if (path === "bad.md") throw new Error("disk exploded");
      return read(path);
    };
    await b.engine.start();
    await settle([a, b]);
    expect(b.notices).toContainEqual({ kind: "task-failed", message: "disk exploded" });
    expect(hub.serverText(fileDocName(b, "good.md"))).toBe("ok");
    expect(b.vault.files.get("remote.md")).toBe("from A");
  });

  it("recovers from a bootstrap interrupted right after start", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "new" });
    await settle([a]);
    const first = await start(hub, "B", { "a.md": "old" });
    await first.engine.stop();
    running.splice(running.indexOf(first), 1);
    const b = await restartDevice(hub, first);
    running.push(b);
    await settle([a, b]);
    const copies = [...b.vault.files.keys()].filter((path) => path.includes("(conflict-disk"));
    expect(copies).toHaveLength(1);
    expect(b.vault.files.get(copies[0]!)).toBe("old");
    expect(b.vault.files.get("a.md")).toBe("new");
    expect(hub.serverText(fileDocName(a, "a.md"))).toBe("new");
  });
});

describe("recovery after a device was closed", () => {
  it("does not revert remote edits made while the device was closed (regression: closed-device revert)", async () => {
    const hub = new LoopbackHub();
    const desktop = await start(hub, "desktop", { "a.md": "v1" });
    const phone = await start(hub, "phone");
    await settle([desktop, phone]);
    await desktop.engine.stop();
    running.splice(running.indexOf(desktop), 1);

    phone.vault.externalWrite("a.md", "v1 + phone edit");
    await settle([phone]);

    const reopened = await restartDevice(hub, desktop);
    running.push(reopened);
    await settle([reopened, phone]);
    expect(reopened.vault.files.get("a.md")).toBe("v1 + phone edit");
    expect(hub.serverText(fileDocName(phone, "a.md"))).toBe("v1 + phone edit");
  });

  it("merges disk edits made while closed with remote edits", async () => {
    const hub = new LoopbackHub();
    const desktop = await start(hub, "desktop", { "a.md": "l1\nl2\n" });
    const phone = await start(hub, "phone");
    await settle([desktop, phone]);
    await desktop.engine.stop();
    running.splice(running.indexOf(desktop), 1);

    phone.vault.externalWrite("a.md", "l1\nl2\nphone\n");
    await settle([phone]);
    desktop.vault.externalWrite("a.md", "L1\nl2\n");

    const reopened = await restartDevice(hub, desktop);
    running.push(reopened);
    await settle([reopened, phone]);
    expect(reopened.vault.files.get("a.md")).toBe("L1\nl2\nphone\n");
    expect(phone.vault.files.get("a.md")).toBe("L1\nl2\nphone\n");
  });

  it("propagates files deleted while the device was closed", async () => {
    const hub = new LoopbackHub();
    const desktop = await start(hub, "desktop", { "a.md": "x" });
    const phone = await start(hub, "phone");
    await settle([desktop, phone]);
    await desktop.engine.stop();
    running.splice(running.indexOf(desktop), 1);
    desktop.vault.externalDelete("a.md");

    const reopened = await restartDevice(hub, desktop);
    running.push(reopened);
    await settle([reopened, phone]);
    expect(phone.vault.files.has("a.md")).toBe(false);
  });

  it("creates exactly one conflict copy for the same path created offline on two devices (regression: offline same path)", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A");
    const b = await start(hub, "B");
    await settle([a, b]);
    a.syncer.setOnline(false);
    b.syncer.setOnline(false);
    a.vault.externalWrite("Daily.md", "from A");
    b.vault.externalWrite("Daily.md", "from B");
    await settle([a, b]);
    a.syncer.setOnline(true);
    b.syncer.setOnline(true);
    await settle([a, b], 12);

    const pathsA = [...a.vault.files.keys()].sort();
    const pathsB = [...b.vault.files.keys()].sort();
    expect(pathsA).toEqual(pathsB);
    expect(pathsA).toHaveLength(2);
    expect(pathsA.filter((path) => path.includes("(conflict "))).toHaveLength(1);
    for (const path of pathsA) expect(a.vault.files.get(path)).toBe(b.vault.files.get(path));
    expect(new Set(pathsA.map((path) => a.vault.files.get(path)))).toEqual(new Set(["from A", "from B"]));
  });
});
