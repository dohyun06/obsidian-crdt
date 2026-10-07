import { describe, expect, it } from "vitest";
import type { SyncNotice } from "../src/core/notices";
import { noticeMessage, statusLabel } from "../src/session/messages";
import type { SyncStatus } from "../src/session/status";

describe("messages", () => {
  it("describes every notice kind with its paths", () => {
    const notices: SyncNotice[] = [
      { kind: "waiting-for-first-sync" },
      { kind: "conflict-copy", path: "a.md", copyPath: "a (conflict-disk 2026-10-08 abcdef).md" },
      { kind: "file-too-large", path: "big.md" },
      { kind: "mass-delete-paused", paths: ["1.md", "2.md"] },
      { kind: "task-failed", message: "boom" },
    ];
    const texts = notices.map(noticeMessage);
    expect(new Set(texts).size).toBe(notices.length);
    expect(texts[1]).toContain("a (conflict-disk 2026-10-08 abcdef).md");
    expect(texts[2]).toContain("big.md");
    expect(texts[2]).toContain("2MB");
    expect(texts[3]).toContain("파일 2개");
  });

  it("labels every status", () => {
    const statuses: SyncStatus[] = ["stopped", "starting", "waiting-first-sync", "connected", "offline", "auth-failed", "deletes-paused", "error"];
    expect(new Set(statuses.map(statusLabel)).size).toBe(statuses.length);
  });
});
