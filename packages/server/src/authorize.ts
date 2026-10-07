import { parseDocName } from "@obsidian-crdt/shared";

export type AuthorizationErrorCode = "invalid-document" | "invalid-token" | "vault-mismatch";

export class AuthorizationError extends Error {
  constructor(readonly code: AuthorizationErrorCode) {
    super(code);
    this.name = "AuthorizationError";
  }
}

export interface ConnectionContext {
  vaultId: string;
}

export function authorize(
  input: { token: string; documentName: string },
  resolveVaultId: (token: string) => string | null,
): ConnectionContext {
  const parsed = parseDocName(input.documentName);
  if (!parsed) throw new AuthorizationError("invalid-document");
  const vaultId = resolveVaultId(input.token);
  if (!vaultId) throw new AuthorizationError("invalid-token");
  if (vaultId !== parsed.vaultId) throw new AuthorizationError("vault-mismatch");
  return { vaultId };
}
