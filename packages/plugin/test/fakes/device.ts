import { buildFileDocName, CONTENT_TEXT_KEY } from "@obsidian-crdt/shared";
import type * as Y from "yjs";
import type { SyncNotice } from "../../src/core/notices";
import { SyncEngine, type SyncTiming } from "../../src/core/syncEngine";
import { FakeVault } from "./fakeVault";
import { type LoopbackHub, LoopbackSyncer } from "./loopback";
import { MemoryPersistence } from "./memoryPersistence";
import { MemoryStorage } from "./memoryStorage";

export const TEST_VAULT_ID = "test-vault-01";
export const FIXED_NOW = Date.UTC(2026, 9, 7, 12);
export const FAST_TIMING: SyncTiming = {
  diskWriteDebounceMs: 2,
  indexPassDebounceMs: 2,
  renamePairWindowMs: 20,
  massDeleteWindowMs: 60_000,
  massDeleteThreshold: 5,
  editorSnapshotDebounceMs: 2,
};

export interface Device {
  name: string;
  vault: FakeVault;
  storage: MemoryStorage;
  persistence: MemoryPersistence;
  syncer: LoopbackSyncer;
  engine: SyncEngine;
  notices: SyncNotice[];
  openInEditor: Set<string>;
  /** Every engine debug event, for asserting on diagnostics. */
  debugEvents: DebugEvent[];
}

export interface DebugEvent {
  event: string;
  fields: Record<string, string | number | boolean>;
}

export interface DeviceOptions {
  files?: Record<string, string>;
  online?: boolean;
  reuse?: Device;
}

export function createDevice(hub: LoopbackHub, name: string, options: DeviceOptions = {}): Device {
  const vault = options.reuse?.vault ?? new FakeVault(options.files ?? {});
  const storage = options.reuse?.storage ?? new MemoryStorage();
  const persistence = options.reuse?.persistence ?? new MemoryPersistence();
  const syncer = new LoopbackSyncer(hub, { online: options.online ?? true });
  const notices: SyncNotice[] = [];
  const openInEditor = options.reuse?.openInEditor ?? new Set<string>();
  const debugEvents: DebugEvent[] = [];
  const engine = new SyncEngine({
    vaultId: TEST_VAULT_ID,
    vault,
    storage,
    syncer,
    persistence,
    isOpenInEditor: (path) => openInEditor.has(path),
    now: () => FIXED_NOW,
    notify: (notice) => notices.push(notice),
    timing: FAST_TIMING,
    debug: (event, fields) => debugEvents.push({ event, fields }),
  });
  return { name, vault, storage, persistence, syncer, engine, notices, openInEditor, debugEvents };
}

export async function startDevice(hub: LoopbackHub, name: string, options: DeviceOptions = {}): Promise<Device> {
  const device = createDevice(hub, name, options);
  await device.engine.start();
  return device;
}

export async function restartDevice(hub: LoopbackHub, device: Device, options: { online?: boolean } = {}): Promise<Device> {
  await device.engine.stop();
  return startDevice(hub, device.name, { reuse: device, online: options.online });
}

/** Lets every device drain its queue and timers; repeated because one device's work wakes the others. */
export async function settle(devices: Device[], rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(devices.map((device) => device.engine.idle()));
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.renamePairWindowMs));
  }
}

export function fileDocName(device: Device, path: string): string {
  const fileId = [...device.storage.records.entries()].find(([, record]) => record.path === path)?.[0];
  if (!fileId) throw new Error(`${device.name} has no record for ${path}`);
  return buildFileDocName(TEST_VAULT_ID, fileId);
}

/** Opens the file in a (simulated) bound editor and returns the Y.Text that yCollab would edit. */
export function openEditor(device: Device, path: string): Y.Text {
  device.openInEditor.add(path);
  return device.persistence.attachedDoc(fileDocName(device, path)).getText(CONTENT_TEXT_KEY);
}

/** What Plan 2's editor binding does when the tab closes. */
export function closeEditor(device: Device, path: string): void {
  device.openInEditor.delete(path);
  device.engine.notifyEditorClosed(path);
}
