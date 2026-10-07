import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("install-dev script", () => {
  it("copies the built plugin into the vault's plugin folder", () => {
    const dist = mkdtempSync(join(tmpdir(), "crdt-dist-"));
    for (const name of ["main.js", "manifest.json", "styles.css"]) writeFileSync(join(dist, name), name);
    const vault = mkdtempSync(join(tmpdir(), "crdt-vault-"));
    mkdirSync(join(vault, ".obsidian"));
    execFileSync("node", ["scripts/install-dev.mjs", vault, "--dist", dist], { cwd: PLUGIN_DIR });
    for (const name of ["main.js", "manifest.json", "styles.css"]) expect(existsSync(join(vault, ".obsidian/plugins/crdt-sync", name))).toBe(true);
  });

  it("refuses a folder that is not an Obsidian vault", () => {
    const notVault = mkdtempSync(join(tmpdir(), "crdt-notvault-"));
    expect(() => execFileSync("node", ["scripts/install-dev.mjs", notVault], { cwd: PLUGIN_DIR, stdio: "pipe" })).toThrow();
  });
});
