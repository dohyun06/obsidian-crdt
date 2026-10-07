import { describe, expect, it } from "vitest";
import { InvalidConfigError, readServerConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { createJsonLogger } from "../src/logger";
import { runTokenCommand } from "../src/tokenCommand";
import { TokenStore } from "../src/tokenStore";

function run(args: string[], tokens = new TokenStore(openDatabase(":memory:"))) {
  const lines: string[] = [];
  const code = runTokenCommand(args, tokens, (line) => lines.push(line));
  return { code, lines, tokens };
}

describe("readServerConfig", () => {
  it("uses defaults", () => {
    expect(readServerConfig({})).toEqual({ port: 1234, address: "127.0.0.1", dbPath: "./data/sync.db" });
  });

  it("reads overrides", () => {
    expect(readServerConfig({ PORT: "4000", HOST: "0.0.0.0", DB_PATH: "/data/x.db" })).toEqual({
      port: 4000,
      address: "0.0.0.0",
      dbPath: "/data/x.db",
    });
  });

  it("rejects invalid ports", () => {
    for (const PORT of ["0", "70000", "abc", "12.5"]) {
      expect(() => readServerConfig({ PORT })).toThrow(InvalidConfigError);
    }
  });
});

describe("token command", () => {
  it("creates a token and prints it once", () => {
    const { code, lines, tokens } = run(["token", "create", "my-vault-01"]);
    expect(code).toBe(0);
    const tokenLine = lines.find((line) => line.startsWith("token: "));
    expect(tokenLine).toBeDefined();
    expect(tokens.resolveVaultId(tokenLine!.slice("token: ".length))).toBe("my-vault-01");
  });

  it("reports invalid vault ids with exit code 1", () => {
    const { code, lines } = run(["token", "create", "Bad Vault"]);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("invalid vault id");
  });

  it("revokes and lists tokens", () => {
    const tokens = new TokenStore(openDatabase(":memory:"));
    const issued = tokens.issue("my-vault-01");
    expect(run(["token", "revoke", issued.tokenId], tokens).code).toBe(0);
    expect(run(["token", "revoke", issued.tokenId], tokens).code).toBe(1);
    const listed = run(["token", "list"], tokens);
    expect(listed.lines.join("\n")).toContain(issued.tokenId);
    expect(listed.lines.join("\n")).toContain("revoked");
  });

  it("prints usage for unknown commands", () => {
    expect(run(["nope"]).code).toBe(2);
    expect(run(["token", "create"]).code).toBe(2);
  });
});

describe("createJsonLogger", () => {
  it("writes one JSON object per line and keeps reserved keys authoritative", () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line), () => new Date("2026-10-07T00:00:00Z"));
    logger.log("info", "server.listening", { port: 1234, level: "spoofed" });
    expect(JSON.parse(lines[0]!)).toEqual({ port: 1234, level: "info", event: "server.listening", time: "2026-10-07T00:00:00.000Z" });
  });
});
