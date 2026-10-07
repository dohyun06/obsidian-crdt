import { describe, expect, it } from "vitest";
import {
  buildFileDocName,
  buildIndexDocName,
  InvalidDocNameError,
  isValidVaultId,
  parseDocName,
} from "@obsidian-crdt/shared";

const VAULT = "my-vault-01";
const FILE = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

describe("document names", () => {
  it("builds and parses an index document name", () => {
    const name = buildIndexDocName(VAULT);
    expect(name).toBe("my-vault-01/index");
    expect(parseDocName(name)).toEqual({ kind: "index", vaultId: VAULT });
  });

  it("builds and parses a file document name", () => {
    const name = buildFileDocName(VAULT, FILE);
    expect(parseDocName(name)).toEqual({ kind: "file", vaultId: VAULT, fileId: FILE });
  });

  it("rejects malformed names", () => {
    for (const bad of ["", "my-vault-01", "my-vault-01/", "SHORT/index", "my-vault-01/notes", `my-vault-01/${FILE}/x`, `../${FILE}`]) {
      expect(parseDocName(bad)).toBeNull();
    }
  });

  it("refuses to build names from invalid ids", () => {
    expect(() => buildIndexDocName("Bad Vault")).toThrow(InvalidDocNameError);
    expect(() => buildFileDocName(VAULT, "not-a-uuid")).toThrow(InvalidDocNameError);
  });

  it("validates vault id length bounds", () => {
    expect(isValidVaultId("a".repeat(8))).toBe(true);
    expect(isValidVaultId("a".repeat(7))).toBe(false);
    expect(isValidVaultId("a".repeat(65))).toBe(false);
  });
});
