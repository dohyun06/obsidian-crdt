import { afterEach, describe, expect, it } from "vitest";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { openDatabase } from "../src/db";
import { DocumentStore } from "../src/documentStore";
import { createJsonLogger } from "../src/logger";
import { createSyncServer } from "../src/syncServer";
import { TokenStore } from "../src/tokenStore";

type Server = ReturnType<typeof createSyncServer>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(db: DatabaseSync): Promise<{ server: Server; url: string; logs: string[] }> {
  const logs: string[] = [];
  const server = createSyncServer({
    port: 0,
    address: "127.0.0.1",
    documents: new DocumentStore(db),
    tokens: new TokenStore(db),
    logger: createJsonLogger((line) => logs.push(line)),
    storeDebounceMs: 0,
  });
  await server.listen();
  cleanups.push(() => server.destroy());
  return { server, url: `ws://127.0.0.1:${server.address.port}`, logs };
}

function connect(url: string, name: string, token: string) {
  const socket = new HocuspocusProviderWebsocket({ url });
  const doc = new Y.Doc();
  let rejectAuth: (reason: string) => void = () => {};
  const authFailed = new Promise<string>((resolve) => {
    rejectAuth = resolve;
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    token,
    onAuthenticationFailed: ({ reason }) => rejectAuth(reason),
  });
  provider.attach();
  const synced = new Promise<void>((resolve) => {
    if (provider.isSynced) resolve();
    provider.on("synced", () => resolve());
  });
  cleanups.push(() => {
    provider.destroy();
    socket.destroy();
  });
  return { doc, synced, authFailed };
}

async function eventually(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("sync server", () => {
  it("syncs a document between two clients holding a valid token", async () => {
    const db = openDatabase(":memory:");
    const { token } = new TokenStore(db).issue("my-vault-01");
    const { url } = await startServer(db);
    const a = connect(url, "my-vault-01/index", token);
    const b = connect(url, "my-vault-01/index", token);
    await Promise.all([a.synced, b.synced]);
    a.doc.getText("content").insert(0, "hello");
    await eventually(() => b.doc.getText("content").toString() === "hello");
  });

  it("rejects an unknown token and logs the rejection without the token", async () => {
    const db = openDatabase(":memory:");
    const { url, logs } = await startServer(db);
    const client = connect(url, "my-vault-01/index", "secret-but-wrong");
    expect(await client.authFailed).toBe("permission-denied");
    expect(logs.join("\n")).toContain("auth.rejected");
    expect(logs.join("\n")).not.toContain("secret-but-wrong");
  });

  it("rejects a token used for another vault", async () => {
    const db = openDatabase(":memory:");
    const { token } = new TokenStore(db).issue("my-vault-01");
    const { url } = await startServer(db);
    const client = connect(url, "other-vault-1/index", token);
    expect(await client.authFailed).toBe("permission-denied");
  });

  it("rejects malformed document names", async () => {
    const db = openDatabase(":memory:");
    const { token } = new TokenStore(db).issue("my-vault-01");
    const { url } = await startServer(db);
    const client = connect(url, "my-vault-01/../../x", token);
    expect(await client.authFailed).toBe("permission-denied");
  });

  it("keeps document state across a server restart", async () => {
    const db = openDatabase(":memory:");
    const { token } = new TokenStore(db).issue("my-vault-01");
    const first = await startServer(db);
    const writer = connect(first.url, "my-vault-01/index", token);
    await writer.synced;
    writer.doc.getText("content").insert(0, "persisted");
    const documents = new DocumentStore(db);
    await eventually(() => documents.load("my-vault-01/index") !== null);
    await first.server.destroy();

    const second = await startServer(db);
    const reader = connect(second.url, "my-vault-01/index", token);
    await reader.synced;
    expect(reader.doc.getText("content").toString()).toBe("persisted");
  });
});
