import { InvalidVaultIdError, type TokenStore } from "./tokenStore";

const USAGE = [
  "usage:",
  "  token create <vaultId>   issue a token (shown once)",
  "  token revoke <tokenId>   revoke a token",
  "  token list               list tokens (no secrets)",
].join("\n");

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export function runTokenCommand(args: readonly string[], tokens: TokenStore, write: (line: string) => void): number {
  const [group, action, value] = args;
  if (group !== "token") return usage(write);
  if (action === "create" && value) return createToken(value, tokens, write);
  if (action === "revoke" && value) return revokeToken(value, tokens, write);
  if (action === "list") return listTokens(tokens, write);
  return usage(write);
}

function usage(write: (line: string) => void): number {
  write(USAGE);
  return EXIT_USAGE;
}

function createToken(vaultId: string, tokens: TokenStore, write: (line: string) => void): number {
  try {
    const issued = tokens.issue(vaultId);
    write(`tokenId: ${issued.tokenId}`);
    write(`vaultId: ${issued.vaultId}`);
    write(`token: ${issued.token}`);
    write("Store this token in the plugin settings now. It cannot be shown again.");
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof InvalidVaultIdError)) throw error;
    write(error.message);
    return EXIT_FAILED;
  }
}

function revokeToken(tokenId: string, tokens: TokenStore, write: (line: string) => void): number {
  if (!tokens.revoke(tokenId)) {
    write(`no active token with id ${tokenId}`);
    return EXIT_FAILED;
  }
  write(`revoked ${tokenId}`);
  return EXIT_OK;
}

function listTokens(tokens: TokenStore, write: (line: string) => void): number {
  for (const summary of tokens.list()) {
    const state = summary.revokedAt === null ? "active" : "revoked";
    write(`${summary.tokenId}  ${summary.vaultId}  ${new Date(summary.createdAt).toISOString()}  ${state}`);
  }
  return EXIT_OK;
}
