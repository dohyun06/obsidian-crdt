import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, fileDocName, settle, startDevice } from "./fakes/device";
import { mulberry32 } from "./fakes/random";

const WORDS = ["alpha", "beta", "가나", "😀", "delta", "\n"];
const STEPS = 40;
const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function insertRandomWord(random: () => number, text: string): string {
  const chars = [...text];
  const at = Math.floor(random() * (chars.length + 1));
  chars.splice(at, 0, pick(random, WORDS));
  return chars.join("");
}

async function runScenario(seed: number): Promise<Device[]> {
  const random = mulberry32(seed);
  const hub = new LoopbackHub();
  const devices = [await startDevice(hub, "A"), await startDevice(hub, "B"), await startDevice(hub, "C")];
  running.push(...devices);
  let created = 0;
  for (let step = 0; step < STEPS; step++) {
    const device = pick(random, devices);
    const roll = random();
    const paths = [...device.vault.files.keys()];
    if (roll < 0.15 || paths.length === 0) {
      device.vault.externalWrite(`${device.name}-${created++}.md`, pick(random, WORDS));
    } else if (roll < 0.85) {
      const path = pick(random, paths);
      device.vault.externalWrite(path, insertRandomWord(random, device.vault.files.get(path) ?? ""));
    } else {
      device.syncer.setOnline(!device.syncer["online"]);
    }
    if (random() < 0.3) await settle(devices, 2);
  }
  for (const device of devices) device.syncer.setOnline(true);
  await settle(devices, 16);
  return devices;
}

describe("convergence", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`converges for seed ${seed}`, async () => {
      const devices = await runScenario(seed);
      const [first, ...rest] = devices as [Device, ...Device[]];
      const expected = Object.fromEntries([...first.vault.files.entries()].sort());
      for (const device of rest) {
        expect(Object.fromEntries([...device.vault.files.entries()].sort())).toEqual(expected);
      }
      for (const [path, text] of first.vault.files) {
        expect(text).not.toMatch(/\uFFFD/);
        expect(fileDocName(first, path)).toBeTruthy();
      }
    });
  }
});
