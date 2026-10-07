import { describe, expect, it } from "vitest";
import { buildConflictPath, withCounter } from "../src/core/conflictPath";

const FILE_ID = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

describe("buildConflictPath", () => {
  it("uses the UTC date so every device computes the same name", () => {
    const justBeforeMidnightUtc = Date.UTC(2026, 9, 7, 23, 59);
    expect(buildConflictPath({ path: "daily/2026-10-07.md", label: "conflict", timestampMs: justBeforeMidnightUtc, fileId: FILE_ID })).toBe(
      "daily/2026-10-07 (conflict 2026-10-07 3f2b8c).md",
    );
  });

  it("supports the disk-copy label", () => {
    expect(buildConflictPath({ path: "a.md", label: "conflict-disk", timestampMs: Date.UTC(2026, 0, 2), fileId: FILE_ID })).toBe(
      "a (conflict-disk 2026-01-02 3f2b8c).md",
    );
  });
});

describe("withCounter", () => {
  it("appends a counter before the extension", () => {
    expect(withCounter("a (conflict-disk 2026-01-02 3f2b8c).md", 2)).toBe("a (conflict-disk 2026-01-02 3f2b8c) 2.md");
  });
});
