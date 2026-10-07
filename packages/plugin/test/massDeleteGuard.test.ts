import { describe, expect, it } from "vitest";
import { MassDeleteGuard } from "../src/core/massDeleteGuard";

describe("MassDeleteGuard", () => {
  it("trips when deletions in the window reach the threshold", () => {
    let now = 0;
    const guard = new MassDeleteGuard({ threshold: 10, windowMs: 10_000, now: () => now });
    expect(guard.record(9)).toBe(false);
    now = 5_000;
    expect(guard.record(1)).toBe(true);
  });

  it("forgets deletions older than the window", () => {
    let now = 0;
    const guard = new MassDeleteGuard({ threshold: 10, windowMs: 10_000, now: () => now });
    guard.record(9);
    now = 10_001;
    expect(guard.record(1)).toBe(false);
  });

  it("starts over after reset", () => {
    const guard = new MassDeleteGuard({ threshold: 2, windowMs: 10_000, now: () => 0 });
    expect(guard.record(2)).toBe(true);
    guard.reset();
    expect(guard.record(1)).toBe(false);
  });
});
