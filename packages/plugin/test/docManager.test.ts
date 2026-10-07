import { describe, expect, it } from "vitest";
import { DISK_ORIGIN, DocManager } from "../src/core/docManager";
import { LoopbackHub, LoopbackSyncer } from "./fakes/loopback";
import { MemoryPersistence } from "./fakes/memoryPersistence";

const VAULT = "test-vault-01";
const FILE = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

function manager(hub: LoopbackHub, persistence = new MemoryPersistence(), online = true) {
  const changed: string[] = [];
  const syncer = new LoopbackSyncer(hub, { online });
  const docs = new DocManager({ vaultId: VAULT, syncer, persistence, onTextChanged: (id) => changed.push(id) });
  return { docs, syncer, changed };
}

describe("DocManager", () => {
  it("returns the same document for repeated opens", async () => {
    const { docs } = manager(new LoopbackHub());
    const [first, second] = await Promise.all([docs.open(FILE), docs.open(FILE)]);
    expect(first).toBe(second);
  });

  it("syncs text with other devices through the syncer", async () => {
    const hub = new LoopbackHub();
    const a = manager(hub);
    const b = manager(hub);
    (await a.docs.open(FILE)).text.insert(0, "hello");
    expect((await b.docs.open(FILE)).text.toString()).toBe("hello");
    expect(hub.serverText(`${VAULT}/${FILE}`)).toBe("hello");
  });

  it("restores state from persistence after a restart", async () => {
    const persistence = new MemoryPersistence();
    const first = manager(new LoopbackHub(), persistence, false);
    (await first.docs.open(FILE)).text.insert(0, "kept offline");
    await first.docs.closeAll();
    const second = manager(new LoopbackHub(), persistence, false);
    expect((await second.docs.open(FILE)).text.toString()).toBe("kept offline");
  });

  it("reports text changes except those made from disk", async () => {
    const hub = new LoopbackHub();
    const a = manager(hub);
    const b = manager(hub);
    const docA = await a.docs.open(FILE);
    await b.docs.open(FILE);
    b.changed.length = 0;
    docA.doc.transact(() => docA.text.insert(0, "disk"), DISK_ORIGIN);
    expect(a.changed).toEqual([]);
    expect(b.changed).toEqual([FILE]);
  });

  it("resolves whenSynced only once online", async () => {
    const { docs, syncer } = manager(new LoopbackHub(), new MemoryPersistence(), false);
    const opened = await docs.open(FILE);
    expect(opened.sync.isSynced()).toBe(false);
    let synced = false;
    void opened.sync.whenSynced().then(() => (synced = true));
    await Promise.resolve();
    expect(synced).toBe(false);
    syncer.setOnline(true);
    await opened.sync.whenSynced();
    expect(opened.sync.isSynced()).toBe(true);
  });
});
