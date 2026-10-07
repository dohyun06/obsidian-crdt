import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readServerConfig } from "../config";
import { openDatabase } from "../db";
import { runTokenCommand } from "../tokenCommand";
import { TokenStore } from "../tokenStore";

const config = readServerConfig(process.env);
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);
try {
  process.exitCode = runTokenCommand(process.argv.slice(2), new TokenStore(db), (line) => process.stdout.write(`${line}\n`));
} finally {
  db.close();
}
