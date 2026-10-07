import { describe, expect, it } from "vitest";
import { AuthorizationError, authorize } from "../src/authorize";

const resolve = (token: string) => (token === "good" ? "my-vault-01" : null);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AuthorizationError) return error.code;
    throw error;
  }
  return undefined;
}

describe("authorize", () => {
  it("accepts a valid token for its own vault", () => {
    expect(authorize({ token: "good", documentName: "my-vault-01/index" }, resolve)).toEqual({ vaultId: "my-vault-01" });
  });

  it("rejects malformed document names before looking at the token", () => {
    expect(codeOf(() => authorize({ token: "good", documentName: "../etc" }, resolve))).toBe("invalid-document");
  });

  it("rejects unknown tokens", () => {
    expect(codeOf(() => authorize({ token: "bad", documentName: "my-vault-01/index" }, resolve))).toBe("invalid-token");
  });

  it("rejects access to another vault", () => {
    expect(codeOf(() => authorize({ token: "good", documentName: "other-vault-1/index" }, resolve))).toBe("vault-mismatch");
  });
});
