import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db";
import { DocumentStore } from "../src/documentStore";
import { InvalidVaultIdError, TokenStore } from "../src/tokenStore";

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("DocumentStore", () => {
  it("returns null for unknown documents", () => {
    expect(new DocumentStore(db).load("my-vault-01/index")).toBeNull();
  });

  it("saves and overwrites document state", () => {
    const store = new DocumentStore(db);
    store.save("my-vault-01/index", new Uint8Array([1, 2, 3]));
    store.save("my-vault-01/index", new Uint8Array([4, 5]));
    expect(Array.from(store.load("my-vault-01/index") ?? [])).toEqual([4, 5]);
  });
});

describe("TokenStore", () => {
  it("issues a token that resolves to its vault", () => {
    const tokens = new TokenStore(db);
    const issued = tokens.issue("my-vault-01");
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    expect(tokens.resolveVaultId(issued.token)).toBe("my-vault-01");
  });

  it("stores only a hash of the token", () => {
    const issued = new TokenStore(db).issue("my-vault-01");
    const row = db.prepare("SELECT token_hash FROM tokens WHERE id = ?").get(issued.tokenId) as { token_hash: string };
    expect(row.token_hash).not.toContain(issued.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not resolve unknown, empty or revoked tokens", () => {
    const tokens = new TokenStore(db);
    const issued = tokens.issue("my-vault-01");
    expect(tokens.resolveVaultId("nope")).toBeNull();
    expect(tokens.resolveVaultId("")).toBeNull();
    expect(tokens.revoke(issued.tokenId)).toBe(true);
    expect(tokens.revoke(issued.tokenId)).toBe(false);
    expect(tokens.resolveVaultId(issued.token)).toBeNull();
  });

  it("rejects invalid vault ids", () => {
    expect(() => new TokenStore(db).issue("Bad Vault")).toThrow(InvalidVaultIdError);
  });

  it("lists tokens without secrets", () => {
    const tokens = new TokenStore(db, () => 42);
    const issued = tokens.issue("my-vault-01");
    expect(tokens.list()).toEqual([{ tokenId: issued.tokenId, vaultId: "my-vault-01", createdAt: 42, revokedAt: null }]);
  });
});
