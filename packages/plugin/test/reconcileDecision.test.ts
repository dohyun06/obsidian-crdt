import { describe, expect, it } from "vitest";
import { decideDiskReconcile, mergeThreeWay } from "../src/core/reconcileDecision";

describe("decideDiskReconcile", () => {
  it("is in sync when disk equals current", () => {
    expect(decideDiskReconcile({ base: "old", disk: "x", current: "x" })).toEqual({ kind: "in-sync" });
  });

  it("writes current to disk when the disk did not change since base (device was closed)", () => {
    expect(decideDiskReconcile({ base: "v1", disk: "v1", current: "v2 from phone" })).toEqual({
      kind: "write-disk",
      text: "v2 from phone",
    });
  });

  it("takes the disk text when only the disk changed", () => {
    expect(decideDiskReconcile({ base: "v1", disk: "v1 edited", current: "v1" })).toEqual({ kind: "merge", text: "v1 edited" });
  });

  it("merges disk and remote changes made to different lines", () => {
    const decision = decideDiskReconcile({ base: "a\nb\nc\n", disk: "a\nB\nc\n", current: "a\nb\nc\nd\n" });
    expect(decision).toEqual({ kind: "merge", text: "a\nB\nc\nd\n" });
  });

  it("keeps the server text and copies the disk text when there is no base (bootstrap)", () => {
    expect(decideDiskReconcile({ base: null, disk: "stale clone", current: "server" })).toEqual({
      kind: "conflict",
      keep: "server",
      diskCopy: "stale clone",
    });
  });

  it("takes the disk text when there is no base and the server document is empty", () => {
    expect(decideDiskReconcile({ base: null, disk: "local", current: "" })).toEqual({ kind: "merge", text: "local" });
  });

  it("reports a conflict when the disk patch cannot be placed", () => {
    const decision = decideDiskReconcile({
      base: "The quick brown fox jumps over the lazy dog",
      disk: "The quick red fox jumps over the lazy dog",
      current: "0123456789",
    });
    expect(decision.kind).toBe("conflict");
  });
});

describe("mergeThreeWay", () => {
  it("refuses results with lone surrogates", () => {
    const result = mergeThreeWay("😀", "😁", "😀");
    if (result.ok) expect(result.text).toBe("😁");
  });
});
