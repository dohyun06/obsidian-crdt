import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readServerConfig } from "../config";
import { openDatabase } from "../db";
import { DocumentStore } from "../documentStore";
import { createJsonLogger } from "../logger";
import { createSyncServer } from "../syncServer";
import { TokenStore } from "../tokenStore";

const logger = createJsonLogger((line) => process.stdout.write(`${line}\n`));

async function main(): Promise<void> {
  const config = readServerConfig(process.env);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  const server = createSyncServer({
    port: config.port,
    address: config.address,
    documents: new DocumentStore(db),
    tokens: new TokenStore(db),
    logger,
  });
  await server.listen();
  logger.log("info", "server.listening", { address: config.address, port: config.port });

  const shutdown = async (signal: string): Promise<void> => {
    logger.log("info", "server.stopping", { signal });
    await server.destroy();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.log("error", "server.crashed", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
