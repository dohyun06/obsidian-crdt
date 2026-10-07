import { describe, expect, it } from "vitest";
import {
  isSafeRelativePath,
  isSyncablePath,
  isWithinSizeLimit,
  MAX_SYNC_FILE_BYTES,
  normalizeVaultPath,
  utf8ByteLength,
} from "@obsidian-crdt/shared";

describe("vault paths", () => {
  it("unifies separators and strips leading ./ and /", () => {
    expect(normalizeVaultPath("./notes\\a.md")).toBe("notes/a.md");
    expect(normalizeVaultPath("/a.md")).toBe("a.md");
  });

  it("does not change Unicode normalization", () => {
    const nfd = "한글.md".normalize("NFD");
    expect(normalizeVaultPath(nfd)).toBe(nfd);
  });

  it("rejects unsafe paths", () => {
    for (const bad of ["", "../a.md", "a/../b.md", "/abs.md", "C:/x.md", "a//b.md", "a\0.md", "./a.md"]) {
      expect(isSafeRelativePath(bad)).toBe(false);
    }
    expect(isSafeRelativePath("notes/a.md")).toBe(true);
  });

  it("syncs markdown outside excluded folders only", () => {
    expect(isSyncablePath("notes/a.md")).toBe(true);
    expect(isSyncablePath("notes/A.MD")).toBe(true);
    expect(isSyncablePath("image.png")).toBe(false);
    expect(isSyncablePath(".obsidian/workspace.md")).toBe(false);
    expect(isSyncablePath(".trash/old.md")).toBe(false);
    expect(isSyncablePath(".git/x.md")).toBe(false);
    expect(isSyncablePath("custom-config/x.md", ["custom-config/"])).toBe(false);
  });

  it("measures size in UTF-8 bytes", () => {
    expect(utf8ByteLength("가")).toBe(3);
    expect(isWithinSizeLimit("a".repeat(MAX_SYNC_FILE_BYTES))).toBe(true);
    expect(isWithinSizeLimit("a".repeat(MAX_SYNC_FILE_BYTES + 1))).toBe(false);
  });
});
