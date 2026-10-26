import { copyFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const PLUGIN_ID = "crdt-sync";
const FILES = ["main.js", "manifest.json", "styles.css"];
// npm runs workspace scripts inside the package folder; INIT_CWD is where the user typed the command.
const USER_CWD = process.env.INIT_CWD ?? process.cwd();

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
}

const vaultArg = process.argv[2];
if (!vaultArg || vaultArg.startsWith("--")) {
  console.error("usage: npm run install-dev -w @obsidian-crdt/plugin -- <vault path> [--config-dir .obsidian] [--dist dist]");
  process.exit(2);
}
const vault = resolve(USER_CWD, vaultArg);
const configDir = join(vault, option("--config-dir", ".obsidian"));
const dist = resolve(option("--dist", "dist"));

try {
  await stat(configDir);
} catch {
  console.error(`not an Obsidian vault (missing ${configDir})`);
  process.exit(1);
}
const target = join(configDir, "plugins", PLUGIN_ID);
await mkdir(target, { recursive: true });
for (const name of FILES) await copyFile(join(dist, name), join(target, name));
console.log(`installed ${PLUGIN_ID} into ${target}`);
