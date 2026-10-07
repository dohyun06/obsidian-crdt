import { describe, expect, it } from "vitest";
import { EchoTrackingVault } from "../src/core/echoTrackingVault";
import { FakeVault } from "./fakes/fakeVault";

describe("EchoTrackingVault", () => {
  it("consumes the echo of its own rename exactly once", async () => {
    const vault = new EchoTrackingVault(new FakeVault({ "a.md": "x" }));
    await vault.rename("a.md", "b.md");
    const event = { type: "rename", oldPath: "a.md", path: "b.md" } as const;
    expect(vault.consume(event)).toBe(true);
    expect(vault.consume(event)).toBe(false);
  });

  it("consumes the echo of its own trash but not other deletes", async () => {
    const vault = new EchoTrackingVault(new FakeVault({ "a.md": "x", "c.md": "y" }));
    await vault.trash("a.md");
    expect(vault.consume({ type: "delete", path: "c.md" })).toBe(false);
    expect(vault.consume({ type: "delete", path: "a.md" })).toBe(true);
  });

  it("does not expect an echo when the operation failed", async () => {
    const vault = new EchoTrackingVault(new FakeVault({}));
    await expect(vault.rename("missing.md", "b.md")).rejects.toThrow();
    expect(vault.consume({ type: "rename", oldPath: "missing.md", path: "b.md" })).toBe(false);
  });

  it("never swallows create or modify events", () => {
    const vault = new EchoTrackingVault(new FakeVault({}));
    expect(vault.consume({ type: "create", path: "a.md" })).toBe(false);
    expect(vault.consume({ type: "modify", path: "a.md" })).toBe(false);
  });
});
