import { buildIndexDocName } from "@obsidian-crdt/shared";
import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, fileDocName, settle, startDevice, TEST_VAULT_ID } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function pair(): Promise<{ hub: LoopbackHub; a: Device; b: Device }> {
  const hub = new LoopbackHub();
  const a = await startDevice(hub, "A");
  const b = await startDevice(hub, "B");
  running.push(a, b);
  return { hub, a, b };
}

function snapshot(device: Device): Record<string, string> {
  return Object.fromEntries([...device.vault.files.entries()].sort());
}

const TEMPLATE = "# Template\n";

describe("adopting an index entry created on another device", () => {
  it("does not double text when the index entry arrives before the file text (regression: empty-doc adoption)", async () => {
    const { hub, a, b } = await pair();
    a.syncer.setOnline(false);
    a.vault.externalWrite("daily.md", TEMPLATE);
    await settle([a]);
    b.vault.externalWrite("daily.md", TEMPLATE); // B creates the same note from the same template...
    a.syncer.setDocOnline(buildIndexDocName(TEST_VAULT_ID)); // ...while only A's index entry has reached the server
    await settle([a, b]);
    a.syncer.setOnline(true);
    await settle([a, b], 12);

    expect(snapshot(a)).toEqual(snapshot(b));
    expect(snapshot(a)["daily.md"]).toBe(TEMPLATE);
    for (const text of Object.values(snapshot(a))) expect(text).toBe(TEMPLATE);
    expect(hub.serverText(fileDocName(a, "daily.md"))).toBe(TEMPLATE);
    expect(Object.keys(snapshot(a)).filter((path) => path.includes("(conflict-disk")).length).toBeLessThanOrEqual(1);
  });
});
