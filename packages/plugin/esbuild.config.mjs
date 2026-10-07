import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

const production = process.argv[2] === "production";
const OUT_DIR = "dist";

const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: `${OUT_DIR}/main.js`,
  // Obsidian provides these at runtime; Node built-ins are listed so an accidental import fails the bundle test.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  sourcemap: production ? false : "inline",
  minify: production,
  metafile: true,
  logLevel: "warning",
});

await mkdir(OUT_DIR, { recursive: true });
await copyFile("manifest.json", `${OUT_DIR}/manifest.json`);
await copyFile("styles.css", `${OUT_DIR}/styles.css`);
if (process.env.BUNDLE_META === "1") await writeFile(`${OUT_DIR}/meta.json`, JSON.stringify(result.metafile));
