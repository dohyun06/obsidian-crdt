import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isValidVaultId } from "@obsidian-crdt/shared";

const TOKEN_BYTES = 32;

export interface IssuedToken {
  tokenId: string;
  vaultId: string;
  token: string;
}

export interface TokenSummary {
  tokenId: string;
  vaultId: string;
  createdAt: number;
  revokedAt: number | null;
}

export class InvalidVaultIdError extends Error {
  constructor(vaultId: string) {
    super(`invalid vault id: ${vaultId} (expected 8-64 chars of a-z, 0-9, -)`);
    this.name = "InvalidVaultIdError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class TokenStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  issue(vaultId: string): IssuedToken {
    if (!isValidVaultId(vaultId)) throw new InvalidVaultIdError(vaultId);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenId = randomUUID();
    this.db
      .prepare("INSERT INTO tokens (id, vault_id, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
      .run(tokenId, vaultId, hashToken(token), this.now());
    return { tokenId, vaultId, token };
  }

  resolveVaultId(token: string): string | null {
    if (token.length === 0) return null;
    const row = this.db
      .prepare("SELECT vault_id FROM tokens WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashToken(token)) as { vault_id: string } | undefined;
    return row?.vault_id ?? null;
  }

  revoke(tokenId: string): boolean {
    const result = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.now(), tokenId);
    return Number(result.changes) > 0;
  }

  list(): TokenSummary[] {
    const rows = this.db
      .prepare("SELECT id, vault_id, created_at, revoked_at FROM tokens ORDER BY created_at")
      .all() as Array<{ id: string; vault_id: string; created_at: number; revoked_at: number | null }>;
    return rows.map((row) => ({
      tokenId: row.id,
      vaultId: row.vault_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }
}
