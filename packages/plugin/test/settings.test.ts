import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, resolveSessionConfig, userColor } from "../src/settings/settings";

const valid = { ...DEFAULT_SETTINGS, enabled: true, serverUrl: "wss://sync.example.com", vaultId: "my-vault-01", tokenSecretId: "crdt-sync-token" };

describe("settings", () => {
  it("falls back to defaults for missing or mistyped fields", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ serverUrl: 42, deviceName: "Mac", enabled: "yes" })).toEqual({ ...DEFAULT_SETTINGS, deviceName: "Mac" });
  });

  it("never keeps a token in data.json", () => {
    expect(mergeSettings({ token: "secret" })).not.toHaveProperty("token");
  });

  it("resolves a valid configuration with the token from secret storage", () => {
    expect(resolveSessionConfig(valid, (id) => (id === "crdt-sync-token" ? "tok" : null))).toEqual({
      ok: true,
      config: { serverUrl: "wss://sync.example.com", vaultId: "my-vault-01", token: "tok", deviceName: "Obsidian" },
    });
  });

  it("lists every problem", () => {
    const result = resolveSessionConfig({ ...valid, serverUrl: "ws://sync.example.com", vaultId: "Bad Vault", tokenSecretId: "Bad Id" }, () => null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(3);
  });

  it("rejects a missing token", () => {
    expect(resolveSessionConfig(valid, () => "").ok).toBe(false);
  });

  it("derives a stable cursor color from the device name", () => {
    expect(userColor("Mac")).toEqual(userColor("Mac"));
    expect(userColor("Mac")).not.toEqual(userColor("iPhone"));
  });
});
