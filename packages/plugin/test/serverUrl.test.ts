import { describe, expect, it } from "vitest";
import { assertSecureServerUrl, InsecureServerUrlError } from "../src/core/serverUrl";

describe("assertSecureServerUrl", () => {
  it("accepts wss and local ws", () => {
    for (const url of ["wss://sync.example.com", "ws://localhost:1234", "ws://127.0.0.1:1234", "ws://[::1]:1234"]) {
      expect(() => assertSecureServerUrl(url)).not.toThrow();
    }
  });

  it("rejects plain ws to remote hosts, other schemes and garbage", () => {
    for (const url of ["ws://sync.example.com", "https://sync.example.com", "ftp://x", "not a url", ""]) {
      expect(() => assertSecureServerUrl(url)).toThrow(InsecureServerUrlError);
    }
  });
});
