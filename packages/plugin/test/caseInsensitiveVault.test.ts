import { afterEach, describe, expect, it } from "vitest";
import type { SyncNotice } from "../src/core/notices";
import { SyncEngine } from "../src/core/syncEngine";
import { ObsidianVaultAdapter } from "../src/obsidian/vaultAdapter";
import { FAST_TIMING, FIXED_NOW, TEST_VAULT_ID } from "./fakes/device";
import { CaseFoldingObsidianVault } from "./fakes/fakeObsidianVault";
import { LoopbackHub, LoopbackSyncer } from "./fakes/loopback";
import { MemoryPersistence } from "./fakes/memoryPersistence";
import { MemoryStorage } from "./fakes/memoryStorage";

// Spec §9 case risk: macOS/iOS (APFS) vaults treat Note.md and note.md as the same file.
interface CaseDevice {
  vault: CaseFoldingObsidianVault;
  engine: SyncEngine;
  notices: SyncNotice[];
}

const running: CaseDevice[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function startCaseDevice(hub: LoopbackHub, files: Record<string, string>): Promise<CaseDevice> {
  const vault = new CaseFoldingObsidianVault();
  for (const [path, text] of Object.entries(files)) vault.seed(path, text);
  const notices: SyncNotice[] = [];
  const engine = new SyncEngine({
    vaultId: TEST_VAULT_ID,
    vault: new ObsidianVaultAdapter(vault),
    storage: new MemoryStorage(),
    syncer: new LoopbackSyncer(hub),
    persistence: new MemoryPersistence(),
    now: () => FIXED_NOW,
    notify: (notice) => notices.push(notice),
    timing: FAST_TIMING,
  });
  const device = { vault, engine, notices };
  running.push(device);
  await engine.start();
  return device;
}

async function settle(devices: CaseDevice[], rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(devices.map((device) => device.engine.idle()));
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.renamePairWindowMs));
  }
}

function contents(device: CaseDevice): Record<string, string> {
  return Object.fromEntries([...device.vault.files.values()].map((file) => [file.path, file.data]).sort());
}

describe("case-insensitive vaults (spec §9)", () => {
  it("renames one of Note.md and note.md to a conflict name without overwriting either", async () => {
    const hub = new LoopbackHub();
    const a = await startCaseDevice(hub, { "Note.md": "from A" });
    const b = await startCaseDevice(hub, { "note.md": "from B" });
    await settle([a, b]);
    const onA = contents(a);
    expect(onA).toEqual(contents(b));
    expect(Object.values(onA).sort()).toEqual(["from A", "from B"]);
    const paths = Object.keys(onA);
    expect(paths.filter((path) => path.includes("(conflict "))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("conflict-disk"))).toHaveLength(0);
    expect(paths.filter((path) => path === "Note.md" || path === "note.md")).toHaveLength(1);
  });

  it("propagates a case-only rename without losing the text", async () => {
    const hub = new LoopbackHub();
    const a = await startCaseDevice(hub, { "Note.md": "body" });
    const b = await startCaseDevice(hub, {});
    await settle([a, b]);
    expect(contents(b)).toEqual({ "Note.md": "body" });
    await a.vault.rename(a.vault.fileAt("Note.md")!, "note.md");
    await settle([a, b]);
    expect(contents(a)).toEqual({ "note.md": "body" });
    expect(contents(b)).toEqual({ "note.md": "body" });
    a.vault.userModify("note.md", "body edited");
    await settle([a, b]);
    expect(contents(b)).toEqual({ "note.md": "body edited" });
  });
});
