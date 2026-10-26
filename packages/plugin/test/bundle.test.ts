import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_EXTERNALS = new Set(["obsidian", "@codemirror/state", "@codemirror/view"]);
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

interface Metafile {
  outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }>;
}

describe("plugin bundle", () => {
  it("builds main.js that imports only Obsidian-provided modules", () => {
    execFileSync("node", ["esbuild.config.mjs", "production"], { cwd: PLUGIN_DIR, env: { ...process.env, BUNDLE_META: "1" } });
    const meta = JSON.parse(readFileSync(join(PLUGIN_DIR, "dist/meta.json"), "utf8")) as Metafile;
    const externals = Object.values(meta.outputs).flatMap((output) => output.imports.filter((entry) => entry.external).map((entry) => entry.path));
    expect(externals.filter((path) => NODE_BUILTINS.has(path))).toEqual([]);
    expect(externals.filter((path) => !ALLOWED_EXTERNALS.has(path))).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "dist/manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ id: "crdt-sync", minAppVersion: "1.11.4", isDesktopOnly: false });
  });
});
