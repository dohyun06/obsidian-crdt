# Sync Core & Server Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Hocuspocus sync server and an Obsidian-independent sync core that keeps a set of Markdown files converged across devices through Yjs, verified with fake vaults and a real server.

**Architecture:** npm-workspaces monorepo. `packages/shared` holds names, limits and validation used by both sides. `packages/server` is a Hocuspocus server persisting Y.Doc state in `node:sqlite` with per-vault token auth. `packages/plugin/src/core` is the headless engine: it talks to the outside only through ports (`VaultPort`, `StoragePort`, `DocSyncer`, `DocPersistence`), so every behaviour is tested with in-memory fakes and, at the end, against the real server. Plan 2 adds the Obsidian adapters, editor binding and mobile handling on top of this core.

**Tech Stack:** TypeScript 5.9, Node ≥ 24 (`node:sqlite`, global `WebSocket`), Vitest 5, Yjs 13.6, @hocuspocus/server + provider + extension-database 4.7, diff-match-patch 1.0.5, esbuild 0.28, Docker Compose + Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md`

## Global Constraints

- Follow `AGENTS.md`: file ≤ 300 LOC, function ≤ 50 LOC, ≤ 5 parameters, cyclomatic complexity ≤ 10; side effects at the boundary; catch only specific errors; never log tokens or note contents.
- Core code (`packages/plugin/src/core`) must not import `obsidian` or any Node built-in (`fs`, `net`, `crypto` module, `node:*`). Use web APIs only (`crypto.randomUUID`, `TextEncoder`, `WebSocket`).
- Document names: `<vaultId>/index` and `<vaultId>/<fileId>`; vaultId matches `^[a-z0-9-]{8,64}$`; fileId is a lowercase UUID v4.
- Vault paths are relative, `/`-separated, and **not** Unicode-normalized (spec §3.4).
- Synced files: `.md` only, excluding `.obsidian/`, `.trash/`, `.git/`; files over 2 MB (UTF-8 bytes) are skipped with a notice.
- Limits (exact): `DISK_WRITE_DEBOUNCE_MS = 1000`, `RECONNECT_MAX_DELAY_MS = 30000`, `MASS_DELETE_WINDOW_MS = 10000`, `MASS_DELETE_THRESHOLD = 10`, `MAX_SYNC_FILE_BYTES = 2 MB`, `MAX_WS_PAYLOAD_BYTES = 8 MB`.
- Server URL: `wss://` only; `ws://` allowed only for `localhost`, `127.0.0.1`, `[::1]`.
- Tokens: 256-bit random, stored as SHA-256 hex only, revocable.
- Conflict copies: `<stem> (conflict YYYY-MM-DD <fileId[0..6]>).md` for same-path collisions (date = UTC of `createdAt`), `<stem> (conflict-disk YYYY-MM-DD <fileId[0..6]>).md` for disk-vs-server conflicts (date = UTC now, ` 2`, ` 3`… appended if taken).

## Review Focus

1. **macOS NFD file names** (e.g. a Korean name created in Finder): the file must sync to other devices and back without being duplicated or "not found" — pinned in Task 10 (`keeps NFD file names byte-for-byte`).
2. **Empty files**: deleting one empty note and creating another unrelated empty note must not be mistaken for a rename — pinned in Task 10 (`does not pair empty files as a rename`).
3. **A file that is too large, then shrinks under the limit**: it should start syncing once it fits — pinned in Task 10 (`starts syncing a file once it shrinks under the size limit`).
4. **Moving a note into an excluded folder** (`.trash/`, `.obsidian/`): other devices should treat it as deleted, not create the excluded path — pinned in Task 10 (`treats a move into an excluded folder as a delete`).
5. **Rename on one device while another device edits the same note**: the edit must land in the renamed file — pinned in Task 10 (`keeps a concurrent edit when the file is renamed elsewhere`).

---

## File Structure

```
package.json                     # npm workspaces root, test/typecheck scripts
tsconfig.json                    # one strict config for all packages
vitest.config.ts
.gitignore
packages/shared/
  package.json
  src/constants.ts               # limits, keys, excluded prefixes
  src/docName.ts                 # build/parse/validate document names
  src/path.ts                    # path safety, syncable filter, size limit
  src/index.ts
  test/docName.test.ts
  test/path.test.ts
packages/server/
  package.json
  src/db.ts                      # open node:sqlite + schema
  src/documentStore.ts           # load/save Y.Doc state
  src/tokenStore.ts              # issue/resolve/revoke/list tokens
  src/authorize.ts               # pure auth decision
  src/logger.ts                  # JSON structured logger
  src/syncServer.ts              # Hocuspocus server factory
  src/config.ts                  # env → ServerConfig
  src/tokenCommand.ts            # CLI command logic
  src/bin/server.ts              # process entry: server
  src/bin/token.ts               # process entry: token CLI
  src/index.ts
  test/stores.test.ts
  test/authorize.test.ts
  test/syncServer.test.ts
  test/cliAndConfig.test.ts
deploy/
  Dockerfile
  docker-compose.yml
  Caddyfile
  .env.example
  README.md                      # Oracle VM setup (Korean)
packages/plugin/
  package.json
  src/core/textDiff.ts           # code-point diff → Y.Text edits
  src/core/reconcileDecision.ts  # three-way decision (pure)
  src/core/conflictPath.ts
  src/core/massDeleteGuard.ts
  src/core/vaultIndex.ts         # index Y.Doc wrapper
  src/core/ports.ts              # boundary interfaces
  src/core/recordStore.ts        # local fileId → {path, base}
  src/core/docManager.ts         # per-file Y.Doc lifecycle
  src/core/scheduling.ts         # SerialQueue, KeyedDebouncer, waitUntil
  src/core/notices.ts
  src/core/fileReconciler.ts     # disk ⇄ Y.Text for one file
  src/core/localChanges.ts       # vault events → index/docs
  src/core/indexApplier.ts       # index → disk
  src/core/startupScan.ts
  src/core/syncEngine.ts         # orchestration
  src/core/serverUrl.ts
  src/core/hocuspocusSyncer.ts   # DocSyncer over one shared WebSocket
  test/fakes/fakeVault.ts
  test/fakes/memoryStorage.ts
  test/fakes/memoryPersistence.ts
  test/fakes/loopback.ts         # in-process "server" for DocSyncer
  test/fakes/device.ts           # engine harness
  test/fakes/random.ts           # seeded PRNG
  test/*.test.ts
```

---

### Task 1: Workspace scaffold and shared package

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/src/constants.ts`, `packages/shared/src/docName.ts`, `packages/shared/src/path.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/docName.test.ts`, `packages/shared/test/path.test.ts`

**Interfaces:**
- Produces (from `@obsidian-crdt/shared`):
  - constants: `DISK_WRITE_DEBOUNCE_MS`, `INDEX_PASS_DEBOUNCE_MS`, `RENAME_PAIR_WINDOW_MS`, `RECONNECT_MAX_DELAY_MS`, `MASS_DELETE_WINDOW_MS`, `MASS_DELETE_THRESHOLD`, `MAX_SYNC_FILE_BYTES`, `MAX_WS_PAYLOAD_BYTES`, `CONTENT_TEXT_KEY`, `INDEX_FILES_MAP_KEY`, `INDEX_DOC_KEY`, `SYNCABLE_EXTENSION`, `EXCLUDED_PATH_PREFIXES`
  - `isValidVaultId(v: string): boolean`, `isValidFileId(v: string): boolean`
  - `buildIndexDocName(vaultId: string): string`, `buildFileDocName(vaultId: string, fileId: string): string` (throw `InvalidDocNameError`)
  - `parseDocName(name: string): ParsedDocName | null`
  - `normalizeVaultPath(raw: string): string`, `isSafeRelativePath(path: string): boolean`, `isSyncablePath(path: string, extraExcludedPrefixes?: readonly string[]): boolean`, `utf8ByteLength(text: string): number`, `isWithinSizeLimit(text: string): boolean`

- [ ] **Step 1: Create root workspace files**

`package.json`:
```json
{
  "name": "obsidian-crdt",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "check": "npm run typecheck && npm test"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "typescript": "~5.9.3",
    "vitest": "^5.0.3"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["packages/*/src", "packages/*/test", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
```

`.gitignore`:
```
node_modules/
dist/
data/
*.db
.env
.DS_Store
```

`packages/shared/package.json`:
```json
{
  "name": "@obsidian-crdt/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

Run: `npm install`
Expected: creates `package-lock.json` and `node_modules/@obsidian-crdt/shared` symlink, no errors.

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/docName.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  buildFileDocName,
  buildIndexDocName,
  InvalidDocNameError,
  isValidVaultId,
  parseDocName,
} from "@obsidian-crdt/shared";

const VAULT = "my-vault-01";
const FILE = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

describe("document names", () => {
  it("builds and parses an index document name", () => {
    const name = buildIndexDocName(VAULT);
    expect(name).toBe("my-vault-01/index");
    expect(parseDocName(name)).toEqual({ kind: "index", vaultId: VAULT });
  });

  it("builds and parses a file document name", () => {
    const name = buildFileDocName(VAULT, FILE);
    expect(parseDocName(name)).toEqual({ kind: "file", vaultId: VAULT, fileId: FILE });
  });

  it("rejects malformed names", () => {
    for (const bad of ["", "my-vault-01", "my-vault-01/", "SHORT/index", "my-vault-01/notes", `my-vault-01/${FILE}/x`, `../${FILE}`]) {
      expect(parseDocName(bad)).toBeNull();
    }
  });

  it("refuses to build names from invalid ids", () => {
    expect(() => buildIndexDocName("Bad Vault")).toThrow(InvalidDocNameError);
    expect(() => buildFileDocName(VAULT, "not-a-uuid")).toThrow(InvalidDocNameError);
  });

  it("validates vault id length bounds", () => {
    expect(isValidVaultId("a".repeat(8))).toBe(true);
    expect(isValidVaultId("a".repeat(7))).toBe(false);
    expect(isValidVaultId("a".repeat(65))).toBe(false);
  });
});
```

`packages/shared/test/path.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  isSafeRelativePath,
  isSyncablePath,
  isWithinSizeLimit,
  MAX_SYNC_FILE_BYTES,
  normalizeVaultPath,
  utf8ByteLength,
} from "@obsidian-crdt/shared";

describe("vault paths", () => {
  it("unifies separators and strips leading ./ and /", () => {
    expect(normalizeVaultPath("./notes\\a.md")).toBe("notes/a.md");
    expect(normalizeVaultPath("/a.md")).toBe("a.md");
  });

  it("does not change Unicode normalization", () => {
    const nfd = "한글.md".normalize("NFD");
    expect(normalizeVaultPath(nfd)).toBe(nfd);
  });

  it("rejects unsafe paths", () => {
    for (const bad of ["", "../a.md", "a/../b.md", "/abs.md", "C:/x.md", "a//b.md", "a\0.md", "./a.md"]) {
      expect(isSafeRelativePath(bad)).toBe(false);
    }
    expect(isSafeRelativePath("notes/a.md")).toBe(true);
  });

  it("syncs markdown outside excluded folders only", () => {
    expect(isSyncablePath("notes/a.md")).toBe(true);
    expect(isSyncablePath("notes/A.MD")).toBe(true);
    expect(isSyncablePath("image.png")).toBe(false);
    expect(isSyncablePath(".obsidian/workspace.md")).toBe(false);
    expect(isSyncablePath(".trash/old.md")).toBe(false);
    expect(isSyncablePath(".git/x.md")).toBe(false);
    expect(isSyncablePath("custom-config/x.md", ["custom-config/"])).toBe(false);
  });

  it("measures size in UTF-8 bytes", () => {
    expect(utf8ByteLength("가")).toBe(3);
    expect(isWithinSizeLimit("a".repeat(MAX_SYNC_FILE_BYTES))).toBe(true);
    expect(isWithinSizeLimit("a".repeat(MAX_SYNC_FILE_BYTES + 1))).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/shared`
Expected: FAIL — cannot resolve exports from `@obsidian-crdt/shared` (no `src/index.ts`).

- [ ] **Step 4: Implement the shared package**

`packages/shared/src/constants.ts`:
```ts
/** Delay before a remote text change is written to disk for a file that is not open in an editor. */
export const DISK_WRITE_DEBOUNCE_MS = 1000;
/** Delay before remote index changes (create/rename/delete) are applied to disk. */
export const INDEX_PASS_DEBOUNCE_MS = 200;
/** A delete followed by a create with identical content inside this window is a rename (e.g. `git mv`). */
export const RENAME_PAIR_WINDOW_MS = 1500;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const MASS_DELETE_WINDOW_MS = 10_000;
export const MASS_DELETE_THRESHOLD = 10;
export const MAX_SYNC_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const CONTENT_TEXT_KEY = "content";
export const INDEX_FILES_MAP_KEY = "files";
export const INDEX_DOC_KEY = "index";

export const SYNCABLE_EXTENSION = ".md";
export const EXCLUDED_PATH_PREFIXES: readonly string[] = [".obsidian/", ".trash/", ".git/"];
```

`packages/shared/src/docName.ts`:
```ts
import { INDEX_DOC_KEY } from "./constants";

const VAULT_ID_PATTERN = /^[a-z0-9-]{8,64}$/;
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ParsedDocName =
  | { kind: "index"; vaultId: string }
  | { kind: "file"; vaultId: string; fileId: string };

export class InvalidDocNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDocNameError";
  }
}

export function isValidVaultId(value: string): boolean {
  return VAULT_ID_PATTERN.test(value);
}

export function isValidFileId(value: string): boolean {
  return FILE_ID_PATTERN.test(value);
}

export function buildIndexDocName(vaultId: string): string {
  if (!isValidVaultId(vaultId)) throw new InvalidDocNameError(`invalid vault id: ${vaultId}`);
  return `${vaultId}/${INDEX_DOC_KEY}`;
}

export function buildFileDocName(vaultId: string, fileId: string): string {
  if (!isValidVaultId(vaultId)) throw new InvalidDocNameError(`invalid vault id: ${vaultId}`);
  if (!isValidFileId(fileId)) throw new InvalidDocNameError(`invalid file id: ${fileId}`);
  return `${vaultId}/${fileId}`;
}

export function parseDocName(name: string): ParsedDocName | null {
  const parts = name.split("/");
  if (parts.length !== 2) return null;
  const [vaultId, key] = parts as [string, string];
  if (!isValidVaultId(vaultId)) return null;
  if (key === INDEX_DOC_KEY) return { kind: "index", vaultId };
  if (isValidFileId(key)) return { kind: "file", vaultId, fileId: key };
  return null;
}
```

`packages/shared/src/path.ts`:
```ts
import { EXCLUDED_PATH_PREFIXES, MAX_SYNC_FILE_BYTES, SYNCABLE_EXTENSION } from "./constants";

const LEADING_SEPARATORS = /^(?:\.\/|\/)+/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/** Unifies separators only. Unicode normalization is intentionally left alone (spec §3.4). */
export function normalizeVaultPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(LEADING_SEPARATORS, "");
}

export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes("\0")) return false;
  if (path.startsWith("/") || WINDOWS_DRIVE.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Expects a normalized path. */
export function isSyncablePath(path: string, extraExcludedPrefixes: readonly string[] = []): boolean {
  if (!isSafeRelativePath(path)) return false;
  if (!path.toLowerCase().endsWith(SYNCABLE_EXTENSION)) return false;
  const excluded = [...EXCLUDED_PATH_PREFIXES, ...extraExcludedPrefixes];
  return !excluded.some((prefix) => path.startsWith(prefix));
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isWithinSizeLimit(text: string): boolean {
  return utf8ByteLength(text) <= MAX_SYNC_FILE_BYTES;
}
```

`packages/shared/src/index.ts`:
```ts
export * from "./constants";
export * from "./docName";
export * from "./path";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/shared && npm run typecheck`
Expected: all shared tests PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore packages/shared
git commit -m "feat(shared): add workspace scaffold, document names and path rules"
```

---

### Task 2: Server persistence (documents and tokens)

**Files:**
- Create: `packages/server/package.json`, `packages/server/src/db.ts`, `packages/server/src/documentStore.ts`, `packages/server/src/tokenStore.ts`
- Test: `packages/server/test/stores.test.ts`

**Interfaces:**
- Consumes: `isValidVaultId` from shared.
- Produces:
  - `openDatabase(path: string): DatabaseSync`
  - `class DocumentStore { constructor(db: DatabaseSync, now?: () => number); load(name: string): Uint8Array | null; save(name: string, state: Uint8Array): void }`
  - `class TokenStore { constructor(db: DatabaseSync, now?: () => number); issue(vaultId: string): IssuedToken; resolveVaultId(token: string): string | null; revoke(tokenId: string): boolean; list(): TokenSummary[] }`
  - `interface IssuedToken { tokenId: string; vaultId: string; token: string }`
  - `interface TokenSummary { tokenId: string; vaultId: string; createdAt: number; revokedAt: number | null }`
  - `class InvalidVaultIdError extends Error`

- [ ] **Step 1: Create the server package**

`packages/server/package.json`:
```json
{
  "name": "@obsidian-crdt/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "esbuild src/bin/server.ts src/bin/token.ts --bundle --platform=node --format=esm --target=node24 --outdir=dist --external:@hocuspocus/* --external:yjs",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@hocuspocus/extension-database": "^4.7.0",
    "@hocuspocus/server": "^4.7.0",
    "@obsidian-crdt/shared": "*",
    "yjs": "^13.6.33"
  },
  "devDependencies": {
    "@hocuspocus/provider": "^4.7.0",
    "esbuild": "^0.28.2"
  }
}
```

Run: `npm install`
Expected: installs without errors (no native build steps — we use built-in `node:sqlite`).

- [ ] **Step 2: Write the failing tests**

`packages/server/test/stores.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db";
import { DocumentStore } from "../src/documentStore";
import { InvalidVaultIdError, TokenStore } from "../src/tokenStore";

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("DocumentStore", () => {
  it("returns null for unknown documents", () => {
    expect(new DocumentStore(db).load("my-vault-01/index")).toBeNull();
  });

  it("saves and overwrites document state", () => {
    const store = new DocumentStore(db);
    store.save("my-vault-01/index", new Uint8Array([1, 2, 3]));
    store.save("my-vault-01/index", new Uint8Array([4, 5]));
    expect(Array.from(store.load("my-vault-01/index") ?? [])).toEqual([4, 5]);
  });
});

describe("TokenStore", () => {
  it("issues a token that resolves to its vault", () => {
    const tokens = new TokenStore(db);
    const issued = tokens.issue("my-vault-01");
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    expect(tokens.resolveVaultId(issued.token)).toBe("my-vault-01");
  });

  it("stores only a hash of the token", () => {
    const issued = new TokenStore(db).issue("my-vault-01");
    const row = db.prepare("SELECT token_hash FROM tokens WHERE id = ?").get(issued.tokenId) as { token_hash: string };
    expect(row.token_hash).not.toContain(issued.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not resolve unknown, empty or revoked tokens", () => {
    const tokens = new TokenStore(db);
    const issued = tokens.issue("my-vault-01");
    expect(tokens.resolveVaultId("nope")).toBeNull();
    expect(tokens.resolveVaultId("")).toBeNull();
    expect(tokens.revoke(issued.tokenId)).toBe(true);
    expect(tokens.revoke(issued.tokenId)).toBe(false);
    expect(tokens.resolveVaultId(issued.token)).toBeNull();
  });

  it("rejects invalid vault ids", () => {
    expect(() => new TokenStore(db).issue("Bad Vault")).toThrow(InvalidVaultIdError);
  });

  it("lists tokens without secrets", () => {
    const tokens = new TokenStore(db, () => 42);
    const issued = tokens.issue("my-vault-01");
    expect(tokens.list()).toEqual([{ tokenId: issued.tokenId, vaultId: "my-vault-01", createdAt: 42, revokedAt: null }]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/server/test/stores.test.ts`
Expected: FAIL — `../src/db` not found.

- [ ] **Step 4: Implement the stores**

`packages/server/src/db.ts`:
```ts
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
```

`packages/server/src/documentStore.ts`:
```ts
import type { DatabaseSync } from "node:sqlite";

export class DocumentStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  load(name: string): Uint8Array | null {
    const row = this.db.prepare("SELECT data FROM documents WHERE name = ?").get(name) as { data: Uint8Array } | undefined;
    return row ? row.data : null;
  }

  save(name: string, state: Uint8Array): void {
    this.db
      .prepare(
        `INSERT INTO documents (name, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(name, state, this.now());
  }
}
```

`packages/server/src/tokenStore.ts`:
```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isValidVaultId } from "@obsidian-crdt/shared";

const TOKEN_BYTES = 32;

export interface IssuedToken {
  tokenId: string;
  vaultId: string;
  token: string;
}

export interface TokenSummary {
  tokenId: string;
  vaultId: string;
  createdAt: number;
  revokedAt: number | null;
}

export class InvalidVaultIdError extends Error {
  constructor(vaultId: string) {
    super(`invalid vault id: ${vaultId} (expected 8-64 chars of a-z, 0-9, -)`);
    this.name = "InvalidVaultIdError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class TokenStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  issue(vaultId: string): IssuedToken {
    if (!isValidVaultId(vaultId)) throw new InvalidVaultIdError(vaultId);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenId = randomUUID();
    this.db
      .prepare("INSERT INTO tokens (id, vault_id, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
      .run(tokenId, vaultId, hashToken(token), this.now());
    return { tokenId, vaultId, token };
  }

  resolveVaultId(token: string): string | null {
    if (token.length === 0) return null;
    const row = this.db
      .prepare("SELECT vault_id FROM tokens WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashToken(token)) as { vault_id: string } | undefined;
    return row?.vault_id ?? null;
  }

  revoke(tokenId: string): boolean {
    const result = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.now(), tokenId);
    return Number(result.changes) > 0;
  }

  list(): TokenSummary[] {
    const rows = this.db
      .prepare("SELECT id, vault_id, created_at, revoked_at FROM tokens ORDER BY created_at")
      .all() as Array<{ id: string; vault_id: string; created_at: number; revoked_at: number | null }>;
    return rows.map((row) => ({
      tokenId: row.id,
      vaultId: row.vault_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/server/test/stores.test.ts && npm run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/server
git commit -m "feat(server): persist documents and hashed vault tokens in node:sqlite"
```

---

### Task 3: Server auth, Hocuspocus server, logger, config and CLI

**Files:**
- Create: `packages/server/src/authorize.ts`, `packages/server/src/logger.ts`, `packages/server/src/syncServer.ts`, `packages/server/src/config.ts`, `packages/server/src/tokenCommand.ts`, `packages/server/src/bin/server.ts`, `packages/server/src/bin/token.ts`, `packages/server/src/index.ts`
- Test: `packages/server/test/authorize.test.ts`, `packages/server/test/syncServer.test.ts`, `packages/server/test/cliAndConfig.test.ts`

**Interfaces:**
- Consumes: `DocumentStore`, `TokenStore`, `openDatabase` (Task 2); `parseDocName`, `MAX_WS_PAYLOAD_BYTES` (Task 1).
- Produces:
  - `authorize(input: { token: string; documentName: string }, resolveVaultId: (token: string) => string | null): ConnectionContext`
  - `class AuthorizationError extends Error { code: "invalid-document" | "invalid-token" | "vault-mismatch" }`
  - `interface ConnectionContext { vaultId: string }`
  - `createJsonLogger(write: (line: string) => void, now?: () => Date): Logger`; `interface Logger { log(level: LogLevel, event: string, fields?: LogFields): void }`
  - `createSyncServer(options: SyncServerOptions): Server<ConnectionContext>`; `SyncServerOptions { port; address; documents; tokens; logger; storeDebounceMs? }`
  - `readServerConfig(env): ServerConfig`; `runTokenCommand(args, tokens, write): number`
  - `packages/server/src/index.ts` re-exports all of the above plus the stores (Task 12 imports them from `@obsidian-crdt/server`).

- [ ] **Step 1: Write the failing tests**

`packages/server/test/authorize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { AuthorizationError, authorize } from "../src/authorize";

const resolve = (token: string) => (token === "good" ? "my-vault-01" : null);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AuthorizationError) return error.code;
    throw error;
  }
  return undefined;
}

describe("authorize", () => {
  it("accepts a valid token for its own vault", () => {
    expect(authorize({ token: "good", documentName: "my-vault-01/index" }, resolve)).toEqual({ vaultId: "my-vault-01" });
  });

  it("rejects malformed document names before looking at the token", () => {
    expect(codeOf(() => authorize({ token: "good", documentName: "../etc" }, resolve))).toBe("invalid-document");
  });

  it("rejects unknown tokens", () => {
    expect(codeOf(() => authorize({ token: "bad", documentName: "my-vault-01/index" }, resolve))).toBe("invalid-token");
  });

  it("rejects access to another vault", () => {
    expect(codeOf(() => authorize({ token: "good", documentName: "other-vault-1/index" }, resolve))).toBe("vault-mismatch");
  });
});
```

`packages/server/test/syncServer.test.ts`:
```ts
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
```

`packages/server/test/cliAndConfig.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/server`
Expected: FAIL — `../src/authorize`, `../src/syncServer`, `../src/config`, `../src/tokenCommand`, `../src/logger` not found.

- [ ] **Step 3: Implement auth, logger and server factory**

`packages/server/src/authorize.ts`:
```ts
import { parseDocName } from "@obsidian-crdt/shared";

export type AuthorizationErrorCode = "invalid-document" | "invalid-token" | "vault-mismatch";

export class AuthorizationError extends Error {
  constructor(readonly code: AuthorizationErrorCode) {
    super(code);
    this.name = "AuthorizationError";
  }
}

export interface ConnectionContext {
  vaultId: string;
}

export function authorize(
  input: { token: string; documentName: string },
  resolveVaultId: (token: string) => string | null,
): ConnectionContext {
  const parsed = parseDocName(input.documentName);
  if (!parsed) throw new AuthorizationError("invalid-document");
  const vaultId = resolveVaultId(input.token);
  if (!vaultId) throw new AuthorizationError("invalid-token");
  if (vaultId !== parsed.vaultId) throw new AuthorizationError("vault-mismatch");
  return { vaultId };
}
```

`packages/server/src/logger.ts`:
```ts
export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

/** Never pass tokens or note contents in `fields`. */
export function createJsonLogger(write: (line: string) => void, now: () => Date = () => new Date()): Logger {
  return {
    log(level, event, fields = {}) {
      write(JSON.stringify({ ...fields, level, event, time: now().toISOString() }));
    },
  };
}
```

`packages/server/src/syncServer.ts`:
```ts
import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import { MAX_WS_PAYLOAD_BYTES } from "@obsidian-crdt/shared";
import { AuthorizationError, authorize, type ConnectionContext } from "./authorize";
import type { DocumentStore } from "./documentStore";
import type { Logger } from "./logger";
import type { TokenStore } from "./tokenStore";

const DEFAULT_STORE_DEBOUNCE_MS = 2000;
const MAX_LOGGED_NAME_LENGTH = 120;

export interface SyncServerOptions {
  port: number;
  address: string;
  documents: DocumentStore;
  tokens: TokenStore;
  logger: Logger;
  storeDebounceMs?: number;
}

export function createSyncServer(options: SyncServerOptions): Server<ConnectionContext> {
  const { documents, tokens, logger } = options;
  return new Server<ConnectionContext>({
    port: options.port,
    address: options.address,
    quiet: true,
    stopOnSignals: false,
    debounce: options.storeDebounceMs ?? DEFAULT_STORE_DEBOUNCE_MS,
    websocketOptions: { maxPayload: MAX_WS_PAYLOAD_BYTES },
    extensions: [
      new Database({
        fetch: async ({ documentName }) => documents.load(documentName),
        store: async ({ documentName, state }) => documents.save(documentName, state),
      }),
    ],
    async onAuthenticate({ token, documentName, socketId }) {
      const loggedName = documentName.slice(0, MAX_LOGGED_NAME_LENGTH);
      try {
        const context = authorize({ token, documentName }, (candidate) => tokens.resolveVaultId(candidate));
        logger.log("info", "auth.accepted", { socketId, documentName: loggedName });
        return context;
      } catch (error) {
        if (error instanceof AuthorizationError) {
          logger.log("warn", "auth.rejected", { socketId, documentName: loggedName, code: error.code });
        }
        throw error;
      }
    },
  });
}
```

- [ ] **Step 4: Implement config, CLI logic, entry points and barrel**

`packages/server/src/config.ts`:
```ts
const DEFAULT_PORT = 1234;
const DEFAULT_ADDRESS = "127.0.0.1";
const DEFAULT_DB_PATH = "./data/sync.db";
const MAX_PORT = 65_535;

export interface ServerConfig {
  port: number;
  address: string;
  dbPath: string;
}

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigError";
  }
}

export function readServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const port = env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new InvalidConfigError(`PORT must be an integer between 1 and ${MAX_PORT}, got "${env.PORT}"`);
  }
  return { port, address: env.HOST ?? DEFAULT_ADDRESS, dbPath: env.DB_PATH ?? DEFAULT_DB_PATH };
}
```

`packages/server/src/tokenCommand.ts`:
```ts
import { InvalidVaultIdError, type TokenStore } from "./tokenStore";

const USAGE = [
  "usage:",
  "  token create <vaultId>   issue a token (shown once)",
  "  token revoke <tokenId>   revoke a token",
  "  token list               list tokens (no secrets)",
].join("\n");

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export function runTokenCommand(args: readonly string[], tokens: TokenStore, write: (line: string) => void): number {
  const [group, action, value] = args;
  if (group !== "token") return usage(write);
  if (action === "create" && value) return createToken(value, tokens, write);
  if (action === "revoke" && value) return revokeToken(value, tokens, write);
  if (action === "list") return listTokens(tokens, write);
  return usage(write);
}

function usage(write: (line: string) => void): number {
  write(USAGE);
  return EXIT_USAGE;
}

function createToken(vaultId: string, tokens: TokenStore, write: (line: string) => void): number {
  try {
    const issued = tokens.issue(vaultId);
    write(`tokenId: ${issued.tokenId}`);
    write(`vaultId: ${issued.vaultId}`);
    write(`token: ${issued.token}`);
    write("Store this token in the plugin settings now. It cannot be shown again.");
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof InvalidVaultIdError)) throw error;
    write(error.message);
    return EXIT_FAILED;
  }
}

function revokeToken(tokenId: string, tokens: TokenStore, write: (line: string) => void): number {
  if (!tokens.revoke(tokenId)) {
    write(`no active token with id ${tokenId}`);
    return EXIT_FAILED;
  }
  write(`revoked ${tokenId}`);
  return EXIT_OK;
}

function listTokens(tokens: TokenStore, write: (line: string) => void): number {
  for (const summary of tokens.list()) {
    const state = summary.revokedAt === null ? "active" : "revoked";
    write(`${summary.tokenId}  ${summary.vaultId}  ${new Date(summary.createdAt).toISOString()}  ${state}`);
  }
  return EXIT_OK;
}
```

`packages/server/src/bin/server.ts`:
```ts
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
```

`packages/server/src/bin/token.ts`:
```ts
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
```

`packages/server/src/index.ts`:
```ts
export * from "./authorize";
export * from "./config";
export * from "./db";
export * from "./documentStore";
export * from "./logger";
export * from "./syncServer";
export * from "./tokenCommand";
export * from "./tokenStore";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: all server tests PASS, typecheck exits 0.

- [ ] **Step 6: Build and smoke-test the binaries**

Run:
```bash
npm run build -w @obsidian-crdt/server
DB_PATH=$TMPDIR/obsidian-crdt-smoke.db node packages/server/dist/token.js token create smoke-vault-1
DB_PATH=$TMPDIR/obsidian-crdt-smoke.db node packages/server/dist/token.js token list
rm -f $TMPDIR/obsidian-crdt-smoke.db*
```
Expected: `dist/server.js` and `dist/token.js` exist; create prints `token: …`; list prints one `active` row.

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): authenticate vault tokens and serve Hocuspocus over node:sqlite"
```

---

### Task 4: Deployment files for the Oracle VM

**Files:**
- Create: `deploy/Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/README.md`, `.dockerignore`

**Interfaces:**
- Consumes: `packages/server` build (`dist/server.js`, `dist/token.js`), env `PORT`, `HOST`, `DB_PATH` (Task 3).
- Produces: `docker compose up -d --build` from `deploy/` serves `wss://$SYNC_DOMAIN`.

- [ ] **Step 1: Write the deployment files**

`deploy/Dockerfile`:
```dockerfile
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci
RUN npm run build -w @obsidian-crdt/server

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci --omit=dev --workspace @obsidian-crdt/server
COPY --from=build /app/packages/server/dist packages/server/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "packages/server/dist/server.js"]
```

The whole `packages/` directory is copied so `npm ci` sees every workspace in the lockfile, whichever packages exist yet.

`.dockerignore` (repository root):
```
node_modules
**/node_modules
**/dist
.git
data
*.db
deploy/.env
```

`deploy/docker-compose.yml`:
```yaml
services:
  sync-server:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    environment:
      HOST: 0.0.0.0
      PORT: "1234"
      DB_PATH: /app/data/sync.db
    volumes:
      - sync-data:/app/data
    restart: unless-stopped

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    environment:
      SYNC_DOMAIN: ${SYNC_DOMAIN:?set SYNC_DOMAIN in deploy/.env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - sync-server
    restart: unless-stopped

volumes:
  sync-data: {}
  caddy-data: {}
  caddy-config: {}
```

`deploy/Caddyfile`:
```
{$SYNC_DOMAIN} {
	reverse_proxy sync-server:1234
}
```

`deploy/.env.example`:
```
# Public DNS name pointing at the VM. Caddy obtains the TLS certificate for it.
SYNC_DOMAIN=sync.example.com
```

`deploy/README.md`:
````markdown
# 동기화 서버 배포 (Oracle Free Tier VM)

## 1. 준비
- VM에 Docker와 Docker Compose 플러그인 설치
- 도메인(또는 DDNS)의 A 레코드를 VM 공인 IP로 지정
- OCI 콘솔 → VCN → Security List에 TCP 80, 443 인그레스 허용
- Ubuntu 이미지는 iptables가 기본으로 막고 있으므로 열어준다:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 2. 실행
```bash
cd deploy
cp .env.example .env   # SYNC_DOMAIN 수정
docker compose up -d --build
```

## 3. 토큰 발급 (볼트마다)
```bash
docker compose exec sync-server node packages/server/dist/token.js token create my-vault-01
```
출력된 `token:` 값은 한 번만 표시된다. 플러그인 설정에 바로 입력한다.

폐기와 목록:
```bash
docker compose exec sync-server node packages/server/dist/token.js token list
docker compose exec sync-server node packages/server/dist/token.js token revoke <tokenId>
```

## 4. 백업
문서와 토큰 해시는 `sync-data` 볼륨의 `/app/data/sync.db`에 있다.
```bash
docker compose exec sync-server node -e "require('node:sqlite')" && \
docker run --rm -v deploy_sync-data:/data -v "$PWD":/backup busybox tar czf /backup/sync-data.tgz -C /data .
```

## 5. 보안 메모
- Hocuspocus는 compose 내부 네트워크에만 열려 있고, 외부는 Caddy(80/443)만 노출된다.
- 로그에는 토큰과 노트 내용이 남지 않는다.
````

- [ ] **Step 2: Verify the compose file and image (if Docker is available)**

Run: `cd deploy && SYNC_DOMAIN=localhost docker compose config >/dev/null && docker compose build sync-server`
Expected: config validates; image builds. If Docker is not installed locally, record "Docker build not verified locally" in the commit body and verify on the VM.

- [ ] **Step 3: Commit**

```bash
git add deploy .dockerignore
git commit -m "feat(deploy): add Docker Compose + Caddy setup for the Oracle VM"
```

---

### Task 5: Plugin package and surrogate-safe text diff

**Files:**
- Create: `packages/plugin/package.json`, `packages/plugin/src/core/textDiff.ts`
- Test: `packages/plugin/test/textDiff.test.ts`

**Interfaces:**
- Produces:
  - `type TextEdit = { op: "equal" | "delete" | "insert"; text: string }`
  - `diffByCodePoint(before: string, after: string): TextEdit[]`
  - `applyMinimalDiff(text: Y.Text, next: string, origin: unknown): void` — no-op (no Y update) when unchanged
  - `hasLoneSurrogate(value: string): boolean`
  - `class TooManyDistinctCharactersError extends Error`

- [ ] **Step 1: Create the plugin package**

`packages/plugin/package.json`:
```json
{
  "name": "@obsidian-crdt/plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@hocuspocus/provider": "^4.7.0",
    "@obsidian-crdt/shared": "*",
    "diff-match-patch": "^1.0.5",
    "yjs": "^13.6.33"
  },
  "devDependencies": {
    "@obsidian-crdt/server": "*",
    "@types/diff-match-patch": "^1.0.36"
  }
}
```

Run: `npm install`
Expected: no errors; `npm ls yjs` shows a single deduped `yjs` version (two copies break Yjs).

- [ ] **Step 2: Write the failing tests**

`packages/plugin/test/textDiff.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyMinimalDiff, diffByCodePoint, hasLoneSurrogate } from "../src/core/textDiff";

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

function remoteCopy(doc: Y.Doc): string {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy.getText("content").toString();
}

describe("diffByCodePoint", () => {
  it("never splits a surrogate pair", () => {
    const edits = diffByCodePoint("x😀y", "x😁y");
    for (const edit of edits) expect(hasLoneSurrogate(edit.text)).toBe(false);
  });
});

describe("applyMinimalDiff", () => {
  const cases: Array<[string, string]> = [
    ["x😀y", "x😁y"],
    ["한글 테스트", "한글 수정 테스트"],
    ["a\r\nb", "a\nb"],
    ["", "😀 new"],
    ["😀😀", "😀"],
    ["unchanged", "unchanged"],
  ];

  for (const [before, after] of cases) {
    it(`turns ${JSON.stringify(before)} into ${JSON.stringify(after)} locally and remotely`, () => {
      const doc = docWith(before);
      applyMinimalDiff(doc.getText("content"), after, "test");
      expect(doc.getText("content").toString()).toBe(after);
      expect(remoteCopy(doc)).toBe(after);
    });
  }

  it("emits no update when the text is unchanged", () => {
    const doc = docWith("same");
    let updates = 0;
    doc.on("update", () => updates++);
    applyMinimalDiff(doc.getText("content"), "same", "test");
    expect(updates).toBe(0);
  });

  it("tags the transaction with the given origin", () => {
    const doc = docWith("a");
    const origins: unknown[] = [];
    doc.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));
    applyMinimalDiff(doc.getText("content"), "ab", "disk");
    expect(origins).toEqual(["disk"]);
  });

  it("keeps a concurrent remote edit elsewhere in the text", () => {
    const local = docWith("line one\nline two\n");
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
    remote.getText("content").insert(remote.getText("content").length, "line three\n");
    applyMinimalDiff(local.getText("content"), "LINE ONE\nline two\n", "disk");
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
    expect(local.getText("content").toString()).toBe("LINE ONE\nline two\nline three\n");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/textDiff.test.ts`
Expected: FAIL — `../src/core/textDiff` not found.

- [ ] **Step 4: Implement**

`packages/plugin/src/core/textDiff.ts`:
```ts
import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const SURROGATE_RANGE_START = 0xd800;
const SURROGATE_RANGE_SIZE = 0x800;
const MAX_DISTINCT_CODE_POINTS = 0xffff - SURROGATE_RANGE_SIZE;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const differ = new DiffMatchPatch();

export type TextEdit = { op: "equal" | "delete" | "insert"; text: string };

export class TooManyDistinctCharactersError extends Error {
  constructor() {
    super(`text uses more than ${MAX_DISTINCT_CODE_POINTS} distinct characters; cannot diff safely`);
    this.name = "TooManyDistinctCharactersError";
  }
}

export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value);
}

/**
 * Diffs by Unicode code point. A plain UTF-16 diff can split an emoji's surrogate pair,
 * and Yjs turns a lone surrogate into U+FFFD when it encodes the update (spec §4.3).
 * Each distinct code point is mapped to one BMP non-surrogate char, diffed, then mapped back.
 */
export function diffByCodePoint(before: string, after: string): TextEdit[] {
  const codec = createCodePointCodec();
  const diffs = differ.diff_main(codec.encode(before), codec.encode(after));
  return diffs.map(([op, chunk]) => ({ op: toOpName(op), text: codec.decode(chunk) }));
}

export function applyMinimalDiff(text: Y.Text, next: string, origin: unknown): void {
  const doc = text.doc;
  if (!doc) throw new Error("applyMinimalDiff: Y.Text must belong to a Y.Doc");
  const current = text.toString();
  if (current === next) return;
  const edits = diffByCodePoint(current, next);
  doc.transact(() => {
    let index = 0;
    for (const edit of edits) {
      if (edit.op === "equal") index += edit.text.length;
      else if (edit.op === "delete") text.delete(index, edit.text.length);
      else {
        text.insert(index, edit.text);
        index += edit.text.length;
      }
    }
  }, origin);
}

function toOpName(op: number): TextEdit["op"] {
  if (op === DIFF_DELETE) return "delete";
  if (op === DIFF_INSERT) return "insert";
  return "equal";
}

function createCodePointCodec() {
  const table: string[] = [];
  const ids = new Map<string, number>();
  const toChar = (id: number) => String.fromCharCode(id < SURROGATE_RANGE_START ? id : id + SURROGATE_RANGE_SIZE);
  const toId = (code: number) => (code < SURROGATE_RANGE_START ? code : code - SURROGATE_RANGE_SIZE);
  return {
    encode(value: string): string {
      let out = "";
      for (const codePoint of value) {
        let id = ids.get(codePoint);
        if (id === undefined) {
          if (table.length >= MAX_DISTINCT_CODE_POINTS) throw new TooManyDistinctCharactersError();
          id = table.length;
          table.push(codePoint);
          ids.set(codePoint, id);
        }
        out += toChar(id);
      }
      return out;
    },
    decode(value: string): string {
      let out = "";
      for (let i = 0; i < value.length; i++) out += table[toId(value.charCodeAt(i))] ?? "";
      return out;
    },
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/textDiff.test.ts && npm run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/plugin
git commit -m "feat(core): add code-point diff that keeps emoji intact in Yjs"
```

---

### Task 6: Three-way decision, conflict paths and mass-delete guard

**Files:**
- Create: `packages/plugin/src/core/reconcileDecision.ts`, `packages/plugin/src/core/conflictPath.ts`, `packages/plugin/src/core/massDeleteGuard.ts`
- Test: `packages/plugin/test/reconcileDecision.test.ts`, `packages/plugin/test/conflictPath.test.ts`, `packages/plugin/test/massDeleteGuard.test.ts`

**Interfaces:**
- Consumes: `hasLoneSurrogate` (Task 5), `SYNCABLE_EXTENSION` (Task 1).
- Produces:
  - `type ReconcileDecision = { kind: "in-sync" } | { kind: "write-disk"; text: string } | { kind: "merge"; text: string } | { kind: "conflict"; keep: string; diskCopy: string }`
  - `decideDiskReconcile(input: { base: string | null; disk: string; current: string }): ReconcileDecision`
  - `mergeThreeWay(base: string, disk: string, current: string): { ok: true; text: string } | { ok: false }`
  - `type ConflictLabel = "conflict" | "conflict-disk"`
  - `buildConflictPath(input: { path: string; label: ConflictLabel; timestampMs: number; fileId: string }): string`
  - `withCounter(path: string, counter: number): string`
  - `class MassDeleteGuard { constructor(options: { threshold: number; windowMs: number; now: () => number }); record(count: number): boolean; reset(): void }`

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/reconcileDecision.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decideDiskReconcile, mergeThreeWay } from "../src/core/reconcileDecision";

describe("decideDiskReconcile", () => {
  it("is in sync when disk equals current", () => {
    expect(decideDiskReconcile({ base: "old", disk: "x", current: "x" })).toEqual({ kind: "in-sync" });
  });

  it("writes current to disk when the disk did not change since base (device was closed)", () => {
    expect(decideDiskReconcile({ base: "v1", disk: "v1", current: "v2 from phone" })).toEqual({
      kind: "write-disk",
      text: "v2 from phone",
    });
  });

  it("takes the disk text when only the disk changed", () => {
    expect(decideDiskReconcile({ base: "v1", disk: "v1 edited", current: "v1" })).toEqual({ kind: "merge", text: "v1 edited" });
  });

  it("merges disk and remote changes made to different lines", () => {
    const decision = decideDiskReconcile({ base: "a\nb\nc\n", disk: "a\nB\nc\n", current: "a\nb\nc\nd\n" });
    expect(decision).toEqual({ kind: "merge", text: "a\nB\nc\nd\n" });
  });

  it("keeps the server text and copies the disk text when there is no base (bootstrap)", () => {
    expect(decideDiskReconcile({ base: null, disk: "stale clone", current: "server" })).toEqual({
      kind: "conflict",
      keep: "server",
      diskCopy: "stale clone",
    });
  });

  it("takes the disk text when there is no base and the server document is empty", () => {
    expect(decideDiskReconcile({ base: null, disk: "local", current: "" })).toEqual({ kind: "merge", text: "local" });
  });

  it("reports a conflict when the disk patch cannot be placed", () => {
    const decision = decideDiskReconcile({
      base: "The quick brown fox jumps over the lazy dog",
      disk: "The quick red fox jumps over the lazy dog",
      current: "0123456789",
    });
    expect(decision.kind).toBe("conflict");
  });
});

describe("mergeThreeWay", () => {
  it("refuses results with lone surrogates", () => {
    const result = mergeThreeWay("😀", "😁", "😀");
    if (result.ok) expect(result.text).toBe("😁");
  });
});
```

`packages/plugin/test/conflictPath.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildConflictPath, withCounter } from "../src/core/conflictPath";

const FILE_ID = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

describe("buildConflictPath", () => {
  it("uses the UTC date so every device computes the same name", () => {
    const justBeforeMidnightUtc = Date.UTC(2026, 9, 7, 23, 59);
    expect(buildConflictPath({ path: "daily/2026-10-07.md", label: "conflict", timestampMs: justBeforeMidnightUtc, fileId: FILE_ID })).toBe(
      "daily/2026-10-07 (conflict 2026-10-07 3f2b8c).md",
    );
  });

  it("supports the disk-copy label", () => {
    expect(buildConflictPath({ path: "a.md", label: "conflict-disk", timestampMs: Date.UTC(2026, 0, 2), fileId: FILE_ID })).toBe(
      "a (conflict-disk 2026-01-02 3f2b8c).md",
    );
  });
});

describe("withCounter", () => {
  it("appends a counter before the extension", () => {
    expect(withCounter("a (conflict-disk 2026-01-02 3f2b8c).md", 2)).toBe("a (conflict-disk 2026-01-02 3f2b8c) 2.md");
  });
});
```

`packages/plugin/test/massDeleteGuard.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MassDeleteGuard } from "../src/core/massDeleteGuard";

describe("MassDeleteGuard", () => {
  it("trips when deletions in the window reach the threshold", () => {
    let now = 0;
    const guard = new MassDeleteGuard({ threshold: 10, windowMs: 10_000, now: () => now });
    expect(guard.record(9)).toBe(false);
    now = 5_000;
    expect(guard.record(1)).toBe(true);
  });

  it("forgets deletions older than the window", () => {
    let now = 0;
    const guard = new MassDeleteGuard({ threshold: 10, windowMs: 10_000, now: () => now });
    guard.record(9);
    now = 10_001;
    expect(guard.record(1)).toBe(false);
  });

  it("starts over after reset", () => {
    const guard = new MassDeleteGuard({ threshold: 2, windowMs: 10_000, now: () => 0 });
    expect(guard.record(2)).toBe(true);
    guard.reset();
    expect(guard.record(1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/reconcileDecision.test.ts packages/plugin/test/conflictPath.test.ts packages/plugin/test/massDeleteGuard.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/plugin/src/core/reconcileDecision.ts`:
```ts
import DiffMatchPatch from "diff-match-patch";
import { hasLoneSurrogate } from "./textDiff";

export type ReconcileDecision =
  | { kind: "in-sync" }
  | { kind: "write-disk"; text: string }
  | { kind: "merge"; text: string }
  | { kind: "conflict"; keep: string; diskCopy: string };

export interface ReconcileInput {
  /** Text last agreed between disk and Y.Text on this device; null before the first sync of this file. */
  base: string | null;
  disk: string;
  current: string;
}

export type MergeResult = { ok: true; text: string } | { ok: false };

const patcher = new DiffMatchPatch();

export function mergeThreeWay(base: string, disk: string, current: string): MergeResult {
  const patches = patcher.patch_make(base, disk);
  const [text, applied] = patcher.patch_apply(patches, current);
  if (!applied.every(Boolean) || hasLoneSurrogate(text)) return { ok: false };
  return { ok: true, text };
}

/** Spec §4.3. Pure: decides how to bring disk and Y.Text together for one file. */
export function decideDiskReconcile({ base, disk, current }: ReconcileInput): ReconcileDecision {
  if (disk === current) return { kind: "in-sync" };
  if (base === null) {
    return current === "" ? { kind: "merge", text: disk } : { kind: "conflict", keep: current, diskCopy: disk };
  }
  if (disk === base) return { kind: "write-disk", text: current };
  if (current === base) return { kind: "merge", text: disk };
  const merged = mergeThreeWay(base, disk, current);
  return merged.ok ? { kind: "merge", text: merged.text } : { kind: "conflict", keep: current, diskCopy: disk };
}
```

`packages/plugin/src/core/conflictPath.ts`:
```ts
import { SYNCABLE_EXTENSION } from "@obsidian-crdt/shared";

export type ConflictLabel = "conflict" | "conflict-disk";

const FILE_ID_PREFIX_LENGTH = 6;
const ISO_DATE_LENGTH = 10;

function splitExtension(path: string): { stem: string; extension: string } {
  return path.endsWith(SYNCABLE_EXTENSION)
    ? { stem: path.slice(0, -SYNCABLE_EXTENSION.length), extension: SYNCABLE_EXTENSION }
    : { stem: path, extension: "" };
}

/** Date is UTC so devices in different time zones compute the same name (spec §4.4). */
export function buildConflictPath(input: { path: string; label: ConflictLabel; timestampMs: number; fileId: string }): string {
  const date = new Date(input.timestampMs).toISOString().slice(0, ISO_DATE_LENGTH);
  const { stem, extension } = splitExtension(input.path);
  return `${stem} (${input.label} ${date} ${input.fileId.slice(0, FILE_ID_PREFIX_LENGTH)})${extension}`;
}

export function withCounter(path: string, counter: number): string {
  const { stem, extension } = splitExtension(path);
  return `${stem} ${counter}${extension}`;
}
```

`packages/plugin/src/core/massDeleteGuard.ts`:
```ts
export interface MassDeleteGuardOptions {
  threshold: number;
  windowMs: number;
  now: () => number;
}

export class MassDeleteGuard {
  private timestamps: number[] = [];

  constructor(private readonly options: MassDeleteGuardOptions) {}

  /** Records `count` deletions happening now; returns true when the window reaches the threshold. */
  record(count: number): boolean {
    const now = this.options.now();
    this.timestamps = this.timestamps.filter((at) => now - at <= this.options.windowMs);
    for (let i = 0; i < count; i++) this.timestamps.push(now);
    return this.timestamps.length >= this.options.threshold;
  }

  reset(): void {
    this.timestamps = [];
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/plugin && npm run typecheck`
Expected: PASS. If `reports a conflict when the disk patch cannot be placed` passes as a merge, lower fuzziness by setting `patcher.Match_Threshold = 0.3` in `reconcileDecision.ts` and re-run; record the chosen value in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin
git commit -m "feat(core): add three-way disk decision, conflict names and mass-delete guard"
```

---

### Task 7: Vault index document

**Files:**
- Create: `packages/plugin/src/core/vaultIndex.ts`
- Test: `packages/plugin/test/vaultIndex.test.ts`

**Interfaces:**
- Consumes: `INDEX_FILES_MAP_KEY`, `isSafeRelativePath`, `isValidFileId` (Task 1); `buildConflictPath` (Task 6).
- Produces:
  - `INDEX_LOCAL_ORIGIN: symbol`
  - `interface IndexEntry { fileId: string; path: string; deleted: boolean; createdAt: number }`
  - `interface PathReassignment { fileId: string; fromPath: string; toPath: string }`
  - `class VaultIndex { constructor(doc: Y.Doc, createId?: () => string); register(path: string, createdAt: number): string; get(fileId: string): IndexEntry | null; entries(): IndexEntry[]; liveEntries(): IndexEntry[]; findLiveByPath(path: string): IndexEntry | null; rename(fileId: string, path: string): void; markDeleted(fileId: string): void; planCollisionResolution(): PathReassignment[]; applyReassignments(plan: PathReassignment[]): void; onRemoteChange(listener: () => void): () => void }`
  - `class UnknownFileIdError extends Error`
  - `entries()` is sorted by fileId ascending; invalid remote entries are skipped.

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/vaultIndex.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { UnknownFileIdError, VaultIndex } from "../src/core/vaultIndex";

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CREATED = Date.UTC(2026, 9, 7, 9);

function idsFrom(...ids: string[]): () => string {
  const queue = [...ids];
  return () => {
    const next = queue.shift();
    if (!next) throw new Error("test ran out of ids");
    return next;
  };
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote");
}

describe("VaultIndex", () => {
  it("registers, renames and deletes entries", () => {
    const index = new VaultIndex(new Y.Doc(), idsFrom(ID_A));
    const id = index.register("notes/a.md", CREATED);
    expect(index.get(id)).toEqual({ fileId: ID_A, path: "notes/a.md", deleted: false, createdAt: CREATED });
    index.rename(id, "notes/b.md");
    expect(index.findLiveByPath("notes/b.md")?.fileId).toBe(ID_A);
    index.markDeleted(id);
    expect(index.findLiveByPath("notes/b.md")).toBeNull();
    expect(index.liveEntries()).toEqual([]);
  });

  it("throws for unknown ids", () => {
    expect(() => new VaultIndex(new Y.Doc()).rename(ID_A, "x.md")).toThrow(UnknownFileIdError);
  });

  it("notifies only for changes that did not originate locally", () => {
    const localDoc = new Y.Doc();
    const index = new VaultIndex(localDoc, idsFrom(ID_A));
    let calls = 0;
    index.onRemoteChange(() => calls++);
    index.register("a.md", CREATED);
    expect(calls).toBe(0);

    const otherDoc = new Y.Doc();
    new VaultIndex(otherDoc, idsFrom(ID_B)).register("b.md", CREATED);
    sync(otherDoc, localDoc);
    expect(calls).toBe(1);
  });

  it("plans the same collision resolution on every device", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    new VaultIndex(docA, idsFrom(ID_B)).register("Daily.md", CREATED);
    new VaultIndex(docB, idsFrom(ID_A)).register("Daily.md", CREATED);
    sync(docA, docB);
    sync(docB, docA);

    const planA = new VaultIndex(docA).planCollisionResolution();
    const planB = new VaultIndex(docB).planCollisionResolution();
    expect(planA).toEqual(planB);
    expect(planA).toEqual([{ fileId: ID_B, fromPath: "Daily.md", toPath: "Daily (conflict 2026-10-07 bbbbbb).md" }]);

    const indexA = new VaultIndex(docA);
    indexA.applyReassignments(planA);
    expect(indexA.findLiveByPath("Daily.md")?.fileId).toBe(ID_A);
    expect(indexA.planCollisionResolution()).toEqual([]);
  });

  it("ignores remote entries with unsafe paths or wrong types", () => {
    const doc = new Y.Doc();
    const files = doc.getMap<Y.Map<unknown>>("files");
    const evil = new Y.Map<unknown>();
    files.set(ID_A, evil);
    evil.set("path", "../../outside.md");
    evil.set("deleted", false);
    evil.set("createdAt", CREATED);
    const broken = new Y.Map<unknown>();
    files.set(ID_B, broken);
    broken.set("path", "ok.md");
    broken.set("deleted", "no");
    broken.set("createdAt", CREATED);
    expect(new VaultIndex(doc).entries()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/vaultIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/plugin/src/core/vaultIndex.ts`:
```ts
import * as Y from "yjs";
import { INDEX_FILES_MAP_KEY, isSafeRelativePath, isValidFileId } from "@obsidian-crdt/shared";
import { buildConflictPath } from "./conflictPath";

export const INDEX_LOCAL_ORIGIN = Symbol("index-local");

export interface IndexEntry {
  fileId: string;
  path: string;
  deleted: boolean;
  createdAt: number;
}

export interface PathReassignment {
  fileId: string;
  fromPath: string;
  toPath: string;
}

export class UnknownFileIdError extends Error {
  constructor(fileId: string) {
    super(`unknown file id in index: ${fileId}`);
    this.name = "UnknownFileIdError";
  }
}

type EntryMap = Y.Map<unknown>;

export class VaultIndex {
  private readonly files: Y.Map<EntryMap>;

  constructor(
    private readonly doc: Y.Doc,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {
    this.files = doc.getMap<EntryMap>(INDEX_FILES_MAP_KEY);
  }

  register(path: string, createdAt: number): string {
    const fileId = this.createId();
    this.doc.transact(() => {
      const entry = new Y.Map<unknown>();
      this.files.set(fileId, entry);
      entry.set("path", path);
      entry.set("deleted", false);
      entry.set("createdAt", createdAt);
    }, INDEX_LOCAL_ORIGIN);
    return fileId;
  }

  get(fileId: string): IndexEntry | null {
    const raw = this.files.get(fileId);
    return raw ? readEntry(fileId, raw) : null;
  }

  /** Sorted by fileId so every device iterates in the same order. */
  entries(): IndexEntry[] {
    const result: IndexEntry[] = [];
    this.files.forEach((raw, fileId) => {
      const entry = readEntry(fileId, raw);
      if (entry) result.push(entry);
    });
    return result.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  }

  liveEntries(): IndexEntry[] {
    return this.entries().filter((entry) => !entry.deleted);
  }

  /** When several live entries share a path, the smallest fileId owns it. */
  findLiveByPath(path: string): IndexEntry | null {
    return this.liveEntries().find((entry) => entry.path === path) ?? null;
  }

  rename(fileId: string, path: string): void {
    this.updateField(fileId, "path", path);
  }

  markDeleted(fileId: string): void {
    this.updateField(fileId, "deleted", true);
  }

  planCollisionResolution(): PathReassignment[] {
    const byPath = new Map<string, IndexEntry[]>();
    for (const entry of this.liveEntries()) {
      byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry]);
    }
    const plan: PathReassignment[] = [];
    for (const group of byPath.values()) {
      for (const loser of group.slice(1)) {
        const toPath = buildConflictPath({ path: loser.path, label: "conflict", timestampMs: loser.createdAt, fileId: loser.fileId });
        plan.push({ fileId: loser.fileId, fromPath: loser.path, toPath });
      }
    }
    return plan;
  }

  applyReassignments(plan: PathReassignment[]): void {
    this.doc.transact(() => {
      for (const step of plan) this.files.get(step.fileId)?.set("path", step.toPath);
    }, INDEX_LOCAL_ORIGIN);
  }

  onRemoteChange(listener: () => void): () => void {
    const handler = (_events: unknown, transaction: Y.Transaction) => {
      if (transaction.origin !== INDEX_LOCAL_ORIGIN) listener();
    };
    this.files.observeDeep(handler);
    return () => this.files.unobserveDeep(handler);
  }

  private updateField(fileId: string, key: "path" | "deleted", value: string | boolean): void {
    const raw = this.files.get(fileId);
    if (!raw) throw new UnknownFileIdError(fileId);
    this.doc.transact(() => raw.set(key, value), INDEX_LOCAL_ORIGIN);
  }
}

/** Index entries come from other devices: validate before trusting them. */
function readEntry(fileId: string, raw: unknown): IndexEntry | null {
  if (!isValidFileId(fileId) || !(raw instanceof Y.Map)) return null;
  const path = raw.get("path");
  const deleted = raw.get("deleted");
  const createdAt = raw.get("createdAt");
  if (typeof path !== "string" || !isSafeRelativePath(path)) return null;
  if (typeof deleted !== "boolean" || typeof createdAt !== "number") return null;
  return { fileId, path, deleted, createdAt };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/vaultIndex.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin
git commit -m "feat(core): add vault index with deterministic path collision resolution"
```

---

### Task 8: Ports, record store, doc manager and in-memory fakes

**Files:**
- Create: `packages/plugin/src/core/ports.ts`, `packages/plugin/src/core/recordStore.ts`, `packages/plugin/src/core/docManager.ts`
- Create: `packages/plugin/test/fakes/memoryStorage.ts`, `packages/plugin/test/fakes/memoryPersistence.ts`, `packages/plugin/test/fakes/loopback.ts`
- Test: `packages/plugin/test/docManager.test.ts`, `packages/plugin/test/recordStore.test.ts`

**Interfaces:**
- Consumes: `buildFileDocName`, `CONTENT_TEXT_KEY` (Task 1).
- Produces (`ports.ts`):
  - `type VaultEvent = { type: "create"; path } | { type: "modify"; path } | { type: "delete"; path } | { type: "rename"; oldPath; path }`
  - `interface VaultPort { listFiles(): Promise<string[]>; read(path): Promise<string | null>; replace(path, expected: string | null, next: string): Promise<boolean>; rename(oldPath, newPath): Promise<void>; trash(path): Promise<void>; onEvent(listener): () => void }`
  - `interface FileRecord { path: string; base: string | null }`
  - `interface StoragePort { loadRecords(): Promise<Array<[string, FileRecord]>>; saveRecord(fileId, record): Promise<void>; deleteRecord(fileId): Promise<void>; getFlag(key): Promise<boolean>; setFlag(key, value): Promise<void> }`
  - `interface DocSyncHandle { isSynced(): boolean; whenSynced(): Promise<void>; destroy(): void }`
  - `interface DocSyncer { connect(docName: string, doc: Y.Doc): DocSyncHandle }`
  - `interface PersistedDoc { destroy(): void }`, `interface DocPersistence { attach(docName: string, doc: Y.Doc): Promise<PersistedDoc> }`
- Produces (`recordStore.ts`): `class RecordStore { static load(storage): Promise<RecordStore>; get(fileId): FileRecord | null; findIdByPath(path): string | null; entries(): Array<[string, FileRecord]>; set(fileId, record): Promise<void>; delete(fileId): Promise<void> }`
- Produces (`docManager.ts`): `DISK_ORIGIN: symbol`; `interface OpenedDoc { fileId; doc: Y.Doc; text: Y.Text; sync: DocSyncHandle }`; `class DocManager { constructor(deps: { vaultId; syncer; persistence; onTextChanged: (fileId: string) => void }); open(fileId): Promise<OpenedDoc>; closeAll(): Promise<void> }`
- Produces (fakes): `MemoryStorage`, `MemoryPersistence`, `LoopbackHub { serverText(docName: string): string }`, `LoopbackSyncer { constructor(hub, options?: { online?: boolean }); setOnline(online: boolean): void }`

- [ ] **Step 1: Write the ports (interfaces only, no behaviour to test)**

`packages/plugin/src/core/ports.ts`:
```ts
import type * as Y from "yjs";

export type VaultEvent =
  | { type: "create"; path: string }
  | { type: "modify"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; oldPath: string; path: string };

/** The plugin's view of the vault on disk. Obsidian implements it in Plan 2. */
export interface VaultPort {
  listFiles(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** Writes `next` only if the file still holds `expected` (`null` = must not exist). Returns false if the disk changed. */
  replace(path: string, expected: string | null, next: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Moves to the vault trash (recoverable). */
  trash(path: string): Promise<void>;
  onEvent(listener: (event: VaultEvent) => void): () => void;
}

export interface FileRecord {
  /** Where this device has the file on disk. */
  path: string;
  /** Text last agreed between disk and Y.Text on this device; null before the first sync. */
  base: string | null;
}

export interface StoragePort {
  loadRecords(): Promise<Array<[string, FileRecord]>>;
  saveRecord(fileId: string, record: FileRecord): Promise<void>;
  deleteRecord(fileId: string): Promise<void>;
  getFlag(key: string): Promise<boolean>;
  setFlag(key: string, value: boolean): Promise<void>;
}

export interface DocSyncHandle {
  isSynced(): boolean;
  whenSynced(): Promise<void>;
  destroy(): void;
}

export interface DocSyncer {
  connect(docName: string, doc: Y.Doc): DocSyncHandle;
}

export interface PersistedDoc {
  destroy(): void;
}

/** Loads saved state into `doc` before resolving, then keeps saving its updates. */
export interface DocPersistence {
  attach(docName: string, doc: Y.Doc): Promise<PersistedDoc>;
}
```

- [ ] **Step 2: Write the fakes**

`packages/plugin/test/fakes/memoryStorage.ts`:
```ts
import type { FileRecord, StoragePort } from "../../src/core/ports";

export class MemoryStorage implements StoragePort {
  readonly records = new Map<string, FileRecord>();
  private readonly flags = new Map<string, boolean>();

  async loadRecords(): Promise<Array<[string, FileRecord]>> {
    return [...this.records.entries()].map(([id, record]): [string, FileRecord] => [id, { ...record }]);
  }

  async saveRecord(fileId: string, record: FileRecord): Promise<void> {
    this.records.set(fileId, { ...record });
  }

  async deleteRecord(fileId: string): Promise<void> {
    this.records.delete(fileId);
  }

  async getFlag(key: string): Promise<boolean> {
    return this.flags.get(key) ?? false;
  }

  async setFlag(key: string, value: boolean): Promise<void> {
    this.flags.set(key, value);
  }
}
```

`packages/plugin/test/fakes/memoryPersistence.ts`:
```ts
import * as Y from "yjs";
import type { DocPersistence, PersistedDoc } from "../../src/core/ports";

/** Survives engine restarts in tests, like IndexedDB does on a device. */
export class MemoryPersistence implements DocPersistence {
  private readonly saved = new Map<string, Uint8Array>();

  async attach(docName: string, doc: Y.Doc): Promise<PersistedDoc> {
    const state = this.saved.get(docName);
    if (state) Y.applyUpdate(doc, state, this);
    const save = () => this.saved.set(docName, Y.encodeStateAsUpdate(doc));
    doc.on("update", save);
    save();
    return { destroy: () => doc.off("update", save) };
  }
}
```

`packages/plugin/test/fakes/loopback.ts`:
```ts
import * as Y from "yjs";
import type { DocSyncer, DocSyncHandle } from "../../src/core/ports";

/** In-process stand-in for the sync server: one authoritative Y.Doc per document name. */
export class LoopbackHub {
  private readonly docs = new Map<string, Y.Doc>();

  serverDoc(docName: string): Y.Doc {
    let doc = this.docs.get(docName);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(docName, doc);
    }
    return doc;
  }

  serverText(docName: string): string {
    return this.serverDoc(docName).getText("content").toString();
  }
}

class Link {
  private active = false;
  private resolveSynced: () => void = () => {};
  private synced: Promise<void> = this.resetSynced();

  constructor(
    private readonly server: Y.Doc,
    private readonly client: Y.Doc,
  ) {}

  private readonly fromServer = (update: Uint8Array, origin: unknown) => {
    if (origin !== this) Y.applyUpdate(this.client, update, this);
  };

  private readonly fromClient = (update: Uint8Array, origin: unknown) => {
    if (origin !== this) Y.applyUpdate(this.server, update, this);
  };

  get isUp(): boolean {
    return this.active;
  }

  whenSynced(): Promise<void> {
    return this.synced;
  }

  up(): void {
    if (this.active) return;
    this.active = true;
    Y.applyUpdate(this.server, Y.encodeStateAsUpdate(this.client, Y.encodeStateVector(this.server)), this);
    Y.applyUpdate(this.client, Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(this.client)), this);
    this.server.on("update", this.fromServer);
    this.client.on("update", this.fromClient);
    this.resolveSynced();
  }

  down(): void {
    if (!this.active) return;
    this.active = false;
    this.server.off("update", this.fromServer);
    this.client.off("update", this.fromClient);
    this.synced = this.resetSynced();
  }

  private resetSynced(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveSynced = resolve;
    });
  }
}

export class LoopbackSyncer implements DocSyncer {
  private online: boolean;
  private readonly links = new Set<Link>();

  constructor(
    private readonly hub: LoopbackHub,
    options: { online?: boolean } = {},
  ) {
    this.online = options.online ?? true;
  }

  connect(docName: string, doc: Y.Doc): DocSyncHandle {
    const link = new Link(this.hub.serverDoc(docName), doc);
    this.links.add(link);
    if (this.online) link.up();
    return {
      isSynced: () => link.isUp,
      whenSynced: () => link.whenSynced(),
      destroy: () => {
        link.down();
        this.links.delete(link);
      },
    };
  }

  setOnline(online: boolean): void {
    this.online = online;
    for (const link of this.links) {
      if (online) link.up();
      else link.down();
    }
  }
}
```

- [ ] **Step 3: Write the failing tests**

`packages/plugin/test/recordStore.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RecordStore } from "../src/core/recordStore";
import { MemoryStorage } from "./fakes/memoryStorage";

describe("RecordStore", () => {
  it("indexes records by path and follows renames", async () => {
    const storage = new MemoryStorage();
    const records = await RecordStore.load(storage);
    await records.set("id-1", { path: "a.md", base: "x" });
    await records.set("id-1", { path: "b.md", base: "x" });
    expect(records.findIdByPath("a.md")).toBeNull();
    expect(records.findIdByPath("b.md")).toBe("id-1");
    expect(storage.records.get("id-1")).toEqual({ path: "b.md", base: "x" });
  });

  it("reloads persisted records", async () => {
    const storage = new MemoryStorage();
    await (await RecordStore.load(storage)).set("id-1", { path: "a.md", base: null });
    const reloaded = await RecordStore.load(storage);
    expect(reloaded.get("id-1")).toEqual({ path: "a.md", base: null });
  });

  it("deletes records", async () => {
    const records = await RecordStore.load(new MemoryStorage());
    await records.set("id-1", { path: "a.md", base: "x" });
    await records.delete("id-1");
    expect(records.get("id-1")).toBeNull();
    expect(records.findIdByPath("a.md")).toBeNull();
  });
});
```

`packages/plugin/test/docManager.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DISK_ORIGIN, DocManager } from "../src/core/docManager";
import { LoopbackHub, LoopbackSyncer } from "./fakes/loopback";
import { MemoryPersistence } from "./fakes/memoryPersistence";

const VAULT = "test-vault-01";
const FILE = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

function manager(hub: LoopbackHub, persistence = new MemoryPersistence(), online = true) {
  const changed: string[] = [];
  const syncer = new LoopbackSyncer(hub, { online });
  const docs = new DocManager({ vaultId: VAULT, syncer, persistence, onTextChanged: (id) => changed.push(id) });
  return { docs, syncer, changed };
}

describe("DocManager", () => {
  it("returns the same document for repeated opens", async () => {
    const { docs } = manager(new LoopbackHub());
    const [first, second] = await Promise.all([docs.open(FILE), docs.open(FILE)]);
    expect(first).toBe(second);
  });

  it("syncs text with other devices through the syncer", async () => {
    const hub = new LoopbackHub();
    const a = manager(hub);
    const b = manager(hub);
    (await a.docs.open(FILE)).text.insert(0, "hello");
    expect((await b.docs.open(FILE)).text.toString()).toBe("hello");
    expect(hub.serverText(`${VAULT}/${FILE}`)).toBe("hello");
  });

  it("restores state from persistence after a restart", async () => {
    const persistence = new MemoryPersistence();
    const first = manager(new LoopbackHub(), persistence, false);
    (await first.docs.open(FILE)).text.insert(0, "kept offline");
    await first.docs.closeAll();
    const second = manager(new LoopbackHub(), persistence, false);
    expect((await second.docs.open(FILE)).text.toString()).toBe("kept offline");
  });

  it("reports text changes except those made from disk", async () => {
    const hub = new LoopbackHub();
    const a = manager(hub);
    const b = manager(hub);
    const docA = await a.docs.open(FILE);
    await b.docs.open(FILE);
    b.changed.length = 0;
    docA.doc.transact(() => docA.text.insert(0, "disk"), DISK_ORIGIN);
    expect(a.changed).toEqual([]);
    expect(b.changed).toEqual([FILE]);
  });

  it("resolves whenSynced only once online", async () => {
    const { docs, syncer } = manager(new LoopbackHub(), new MemoryPersistence(), false);
    const opened = await docs.open(FILE);
    expect(opened.sync.isSynced()).toBe(false);
    let synced = false;
    void opened.sync.whenSynced().then(() => (synced = true));
    await Promise.resolve();
    expect(synced).toBe(false);
    syncer.setOnline(true);
    await opened.sync.whenSynced();
    expect(opened.sync.isSynced()).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/recordStore.test.ts packages/plugin/test/docManager.test.ts`
Expected: FAIL — `recordStore` / `docManager` modules not found.

- [ ] **Step 5: Implement record store and doc manager**

`packages/plugin/src/core/recordStore.ts`:
```ts
import type { FileRecord, StoragePort } from "./ports";

/** Cached view of this device's fileId → {path, base} records. Reads are synchronous. */
export class RecordStore {
  private readonly byId = new Map<string, FileRecord>();
  private readonly idByPath = new Map<string, string>();

  private constructor(private readonly storage: StoragePort) {}

  static async load(storage: StoragePort): Promise<RecordStore> {
    const store = new RecordStore(storage);
    for (const [fileId, record] of await storage.loadRecords()) store.cache(fileId, record);
    return store;
  }

  get(fileId: string): FileRecord | null {
    return this.byId.get(fileId) ?? null;
  }

  findIdByPath(path: string): string | null {
    return this.idByPath.get(path) ?? null;
  }

  entries(): Array<[string, FileRecord]> {
    return [...this.byId.entries()];
  }

  async set(fileId: string, record: FileRecord): Promise<void> {
    this.uncache(fileId);
    this.cache(fileId, record);
    await this.storage.saveRecord(fileId, record);
  }

  async delete(fileId: string): Promise<void> {
    this.uncache(fileId);
    await this.storage.deleteRecord(fileId);
  }

  private cache(fileId: string, record: FileRecord): void {
    this.byId.set(fileId, record);
    this.idByPath.set(record.path, fileId);
  }

  private uncache(fileId: string): void {
    const previous = this.byId.get(fileId);
    if (!previous) return;
    this.byId.delete(fileId);
    if (this.idByPath.get(previous.path) === fileId) this.idByPath.delete(previous.path);
  }
}
```

`packages/plugin/src/core/docManager.ts`:
```ts
import * as Y from "yjs";
import { buildFileDocName, CONTENT_TEXT_KEY } from "@obsidian-crdt/shared";
import type { DocPersistence, DocSyncer, DocSyncHandle, PersistedDoc } from "./ports";

/** Origin for Y.Text edits that came from the disk; they must not be written back to disk. */
export const DISK_ORIGIN = Symbol("disk");

export interface OpenedDoc {
  fileId: string;
  doc: Y.Doc;
  text: Y.Text;
  sync: DocSyncHandle;
}

export interface DocManagerDeps {
  vaultId: string;
  syncer: DocSyncer;
  persistence: DocPersistence;
  onTextChanged: (fileId: string) => void;
}

interface DocSlot {
  opened: OpenedDoc;
  persisted: PersistedDoc;
}

export class DocManager {
  private readonly slots = new Map<string, Promise<DocSlot>>();

  constructor(private readonly deps: DocManagerDeps) {}

  async open(fileId: string): Promise<OpenedDoc> {
    let slot = this.slots.get(fileId);
    if (!slot) {
      slot = this.createSlot(fileId);
      this.slots.set(fileId, slot);
    }
    return (await slot).opened;
  }

  async closeAll(): Promise<void> {
    const slots = await Promise.all(this.slots.values());
    this.slots.clear();
    for (const { opened, persisted } of slots) {
      opened.sync.destroy();
      persisted.destroy();
      opened.doc.destroy();
    }
  }

  private async createSlot(fileId: string): Promise<DocSlot> {
    const docName = buildFileDocName(this.deps.vaultId, fileId);
    const doc = new Y.Doc();
    const persisted = await this.deps.persistence.attach(docName, doc);
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== DISK_ORIGIN) this.deps.onTextChanged(fileId);
    });
    const sync = this.deps.syncer.connect(docName, doc);
    return { opened: { fileId, doc, text: doc.getText(CONTENT_TEXT_KEY), sync }, persisted };
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run packages/plugin && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin
git commit -m "feat(core): add ports, record store, doc manager and in-memory fakes"
```

---

### Task 9: Scheduling, notices and the file reconciler

**Files:**
- Create: `packages/plugin/src/core/scheduling.ts`, `packages/plugin/src/core/notices.ts`, `packages/plugin/src/core/fileReconciler.ts`
- Create: `packages/plugin/test/fakes/fakeVault.ts`
- Test: `packages/plugin/test/scheduling.test.ts`, `packages/plugin/test/fileReconciler.test.ts`

**Interfaces:**
- Consumes: `decideDiskReconcile` (Task 6), `buildConflictPath`, `withCounter` (Task 6), `applyMinimalDiff` (Task 5), `DocManager`, `DISK_ORIGIN`, `RecordStore`, ports (Task 8).
- Produces:
  - `class SerialQueue { constructor(onError: (error: unknown) => void); enqueue(task: () => Promise<void>): Promise<void>; get isIdle(): boolean }`
  - `class KeyedDebouncer { schedule(key: string, delayMs: number, action: () => void): void; cancelAll(): void; get size(): number }`
  - `waitUntil(predicate: () => boolean, pollMs?: number): Promise<void>`
  - `type SyncNotice = { kind: "waiting-for-first-sync" } | { kind: "conflict-copy"; path: string; copyPath: string } | { kind: "file-too-large"; path: string } | { kind: "mass-delete-paused"; paths: string[] } | { kind: "task-failed"; message: string }`
  - `class FileReconciler { constructor(deps: FileReconcilerDeps); reconcile(fileId: string): Promise<void> }` with `FileReconcilerDeps { vault: VaultPort; records: RecordStore; docs: DocManager; now: () => number; notify: (notice: SyncNotice) => void; requestRetry: (fileId: string) => void }`
  - `findFreePath(vault: VaultPort, candidate: string): Promise<string>`
  - Fake: `class FakeVault implements VaultPort { files: Map<string,string>; trashed: Array<{path; text}>; externalWrite(path, text): void; externalDelete(path): void; externalRename(oldPath, newPath): void }`

- [ ] **Step 1: Write the FakeVault**

`packages/plugin/test/fakes/fakeVault.ts`:
```ts
import type { VaultEvent, VaultPort } from "../../src/core/ports";

/** In-memory vault. Events are delivered asynchronously, like Obsidian's vault events. */
export class FakeVault implements VaultPort {
  readonly files = new Map<string, string>();
  readonly trashed: Array<{ path: string; text: string }> = [];
  private readonly listeners = new Set<(event: VaultEvent) => void>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(initial)) this.files.set(path, text);
  }

  async listFiles(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async replace(path: string, expected: string | null, next: string): Promise<boolean> {
    if ((this.files.get(path) ?? null) !== expected) return false;
    this.put(path, next);
    return true;
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.move(oldPath, newPath);
  }

  async trash(path: string): Promise<void> {
    const text = this.files.get(path);
    if (text === undefined) return;
    this.files.delete(path);
    this.trashed.push({ path, text });
    this.emit({ type: "delete", path });
  }

  onEvent(listener: (event: VaultEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A change made outside the plugin: git, another editor, Finder. */
  externalWrite(path: string, text: string): void {
    this.put(path, text);
  }

  externalDelete(path: string): void {
    if (this.files.delete(path)) this.emit({ type: "delete", path });
  }

  externalRename(oldPath: string, newPath: string): void {
    this.move(oldPath, newPath);
  }

  private move(oldPath: string, newPath: string): void {
    const text = this.files.get(oldPath);
    if (text === undefined) throw new Error(`FakeVault: rename source missing: ${oldPath}`);
    if (this.files.has(newPath)) throw new Error(`FakeVault: rename target exists: ${newPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, text);
    this.emit({ type: "rename", oldPath, path: newPath });
  }

  private put(path: string, text: string): void {
    const existed = this.files.has(path);
    this.files.set(path, text);
    this.emit(existed ? { type: "modify", path } : { type: "create", path });
  }

  private emit(event: VaultEvent): void {
    queueMicrotask(() => {
      for (const listener of this.listeners) listener(event);
    });
  }
}
```

- [ ] **Step 2: Write the failing tests**

`packages/plugin/test/scheduling.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { KeyedDebouncer, SerialQueue, waitUntil } from "../src/core/scheduling";

describe("SerialQueue", () => {
  it("runs tasks one at a time in order and survives failures", async () => {
    const errors: unknown[] = [];
    const queue = new SerialQueue((error) => errors.push(error));
    const order: number[] = [];
    void queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    });
    void queue.enqueue(async () => {
      throw new Error("boom");
    });
    await queue.enqueue(async () => {
      order.push(3);
    });
    expect(order).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
    expect(queue.isIdle).toBe(true);
  });
});

describe("KeyedDebouncer", () => {
  it("coalesces repeated schedules per key", async () => {
    const debouncer = new KeyedDebouncer();
    let runs = 0;
    debouncer.schedule("a", 5, () => runs++);
    debouncer.schedule("a", 5, () => runs++);
    expect(debouncer.size).toBe(1);
    await waitUntil(() => debouncer.size === 0);
    expect(runs).toBe(1);
  });

  it("cancels everything", async () => {
    const debouncer = new KeyedDebouncer();
    let runs = 0;
    debouncer.schedule("a", 5, () => runs++);
    debouncer.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(runs).toBe(0);
  });
});
```

`packages/plugin/test/fileReconciler.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DocManager } from "../src/core/docManager";
import { FileReconciler } from "../src/core/fileReconciler";
import type { SyncNotice } from "../src/core/notices";
import { RecordStore } from "../src/core/recordStore";
import { FakeVault } from "./fakes/fakeVault";
import { LoopbackHub, LoopbackSyncer } from "./fakes/loopback";
import { MemoryPersistence } from "./fakes/memoryPersistence";
import { MemoryStorage } from "./fakes/memoryStorage";

const VAULT = "test-vault-01";
const FILE = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";
const NOW = Date.UTC(2026, 9, 7, 12);

async function setup(options: { files?: Record<string, string>; online?: boolean; hub?: LoopbackHub } = {}) {
  const hub = options.hub ?? new LoopbackHub();
  const vault = new FakeVault(options.files ?? {});
  const syncer = new LoopbackSyncer(hub, { online: options.online ?? true });
  const records = await RecordStore.load(new MemoryStorage());
  const docs = new DocManager({ vaultId: VAULT, syncer, persistence: new MemoryPersistence(), onTextChanged: () => {} });
  const notices: SyncNotice[] = [];
  const retries: string[] = [];
  const reconciler = new FileReconciler({
    vault,
    records,
    docs,
    now: () => NOW,
    notify: (notice) => notices.push(notice),
    requestRetry: (fileId) => retries.push(fileId),
  });
  return { hub, vault, syncer, records, docs, reconciler, notices, retries };
}

describe("FileReconciler", () => {
  it("writes remote text to disk when the disk did not change", async () => {
    const t = await setup({ files: { "a.md": "v1" } });
    await t.records.set(FILE, { path: "a.md", base: "v1" });
    (await t.docs.open(FILE)).text.insert(0, "v1");
    (await t.docs.open(FILE)).text.insert(2, " + phone");
    await t.reconciler.reconcile(FILE);
    expect(t.vault.files.get("a.md")).toBe("v1 + phone");
    expect(t.records.get(FILE)).toEqual({ path: "a.md", base: "v1 + phone" });
  });

  it("merges an outside disk edit with a concurrent remote edit", async () => {
    const t = await setup({ files: { "a.md": "A\nb\n" } });
    await t.records.set(FILE, { path: "a.md", base: "a\nb\n" });
    (await t.docs.open(FILE)).text.insert(0, "a\nb\nc\n");
    await t.reconciler.reconcile(FILE);
    expect(t.vault.files.get("a.md")).toBe("A\nb\nc\n");
    expect(t.hub.serverText(`${VAULT}/${FILE}`)).toBe("A\nb\nc\n");
  });

  it("does nothing on the modify event caused by its own write (regression: self-write)", async () => {
    const t = await setup({ files: { "a.md": "v1" } });
    await t.records.set(FILE, { path: "a.md", base: "v1" });
    const opened = await t.docs.open(FILE);
    opened.text.insert(0, "v2");
    await t.reconciler.reconcile(FILE);
    let updates = 0;
    opened.doc.on("update", () => updates++);
    await t.reconciler.reconcile(FILE);
    expect(updates).toBe(0);
    expect(t.vault.files.get("a.md")).toBe("v2");
  });

  it("keeps the server text and saves a disk copy on bootstrap conflicts", async () => {
    const hub = new LoopbackHub();
    hub.serverDoc(`${VAULT}/${FILE}`).getText("content").insert(0, "server");
    const t = await setup({ hub, files: { "a.md": "stale" } });
    await t.records.set(FILE, { path: "a.md", base: null });
    await t.reconciler.reconcile(FILE);
    expect(t.vault.files.get("a.md")).toBe("server");
    expect(t.vault.files.get("a (conflict-disk 2026-10-07 3f2b8c).md")).toBe("stale");
    expect(t.notices).toEqual([{ kind: "conflict-copy", path: "a.md", copyPath: "a (conflict-disk 2026-10-07 3f2b8c).md" }]);
  });

  it("waits for the server before reconciling a file with no base (regression: bootstrap doubling)", async () => {
    const hub = new LoopbackHub();
    hub.serverDoc(`${VAULT}/${FILE}`).getText("content").insert(0, "hello");
    const t = await setup({ hub, files: { "a.md": "hello" }, online: false });
    await t.records.set(FILE, { path: "a.md", base: null });
    let done = false;
    const running = t.reconciler.reconcile(FILE).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    t.syncer.setOnline(true);
    await running;
    expect(hub.serverText(`${VAULT}/${FILE}`)).toBe("hello");
    expect(t.vault.files.get("a.md")).toBe("hello");
  });

  it("asks for a retry when the disk changes between read and write", async () => {
    const t = await setup({ files: { "a.md": "v1" } });
    await t.records.set(FILE, { path: "a.md", base: "v1" });
    (await t.docs.open(FILE)).text.insert(0, "v2");
    const originalRead = t.vault.read.bind(t.vault);
    t.vault.read = async (path) => {
      const value = await originalRead(path);
      t.vault.files.set(path, "changed underneath");
      return value;
    };
    await t.reconciler.reconcile(FILE);
    expect(t.retries).toEqual([FILE]);
    expect(t.vault.files.get("a.md")).toBe("changed underneath");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/scheduling.test.ts packages/plugin/test/fileReconciler.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`packages/plugin/src/core/scheduling.ts`:
```ts
/** Runs async tasks strictly one after another. A failing task is reported and does not stop the queue. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(task: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const run = this.tail
      .then(task)
      .catch((error: unknown) => this.onError(error))
      .finally(() => {
        this.pending -= 1;
      });
    this.tail = run;
    return run;
  }

  get isIdle(): boolean {
    return this.pending === 0;
  }
}

export class KeyedDebouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(key: string, delayMs: number, action: () => void): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        action();
      }, delayMs),
    );
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}

const DEFAULT_POLL_MS = 5;

export async function waitUntil(predicate: () => boolean, pollMs = DEFAULT_POLL_MS): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
```

`packages/plugin/src/core/notices.ts`:
```ts
/** User-facing events. Plan 2 turns them into Obsidian notices and status bar text. */
export type SyncNotice =
  | { kind: "waiting-for-first-sync" }
  | { kind: "conflict-copy"; path: string; copyPath: string }
  | { kind: "file-too-large"; path: string }
  | { kind: "mass-delete-paused"; paths: string[] }
  | { kind: "task-failed"; message: string };
```

`packages/plugin/src/core/fileReconciler.ts`:
```ts
import { buildConflictPath, withCounter } from "./conflictPath";
import { DISK_ORIGIN, type DocManager, type OpenedDoc } from "./docManager";
import type { SyncNotice } from "./notices";
import type { VaultPort } from "./ports";
import { decideDiskReconcile, type ReconcileDecision } from "./reconcileDecision";
import type { RecordStore } from "./recordStore";
import { applyMinimalDiff } from "./textDiff";

export interface FileReconcilerDeps {
  vault: VaultPort;
  records: RecordStore;
  docs: DocManager;
  now: () => number;
  notify: (notice: SyncNotice) => void;
  requestRetry: (fileId: string) => void;
}

const FIRST_COUNTER = 2;

export async function findFreePath(vault: VaultPort, candidate: string): Promise<string> {
  if ((await vault.read(candidate)) === null) return candidate;
  for (let counter = FIRST_COUNTER; ; counter++) {
    const next = withCounter(candidate, counter);
    if ((await vault.read(next)) === null) return next;
  }
}

/** Brings one file's disk text and Y.Text together (spec §4.3). */
export class FileReconciler {
  constructor(private readonly deps: FileReconcilerDeps) {}

  async reconcile(fileId: string): Promise<void> {
    const record = this.deps.records.get(fileId);
    if (!record) return;
    const opened = await this.deps.docs.open(fileId);
    // Without a base, the local doc may still be empty; seeding it from disk would double the text (spec §4.5).
    if (record.base === null) await opened.sync.whenSynced();
    const disk = await this.deps.vault.read(record.path);
    if (disk === null) return; // missing files are handled by the delete flow
    const decision = decideDiskReconcile({ base: record.base, disk, current: opened.text.toString() });
    const settled = await this.apply({ fileId, path: record.path, opened, disk }, decision);
    if (!settled) this.deps.requestRetry(fileId);
  }

  private async apply(target: Target, decision: ReconcileDecision): Promise<boolean> {
    switch (decision.kind) {
      case "in-sync":
        await this.saveBase(target, target.disk);
        return true;
      case "write-disk":
        return this.writeAndSave(target, decision.text);
      case "merge":
        applyMinimalDiff(target.opened.text, decision.text, DISK_ORIGIN);
        return this.writeAndSave(target, decision.text);
      case "conflict":
        await this.saveDiskCopy(target, decision.diskCopy);
        return this.writeAndSave(target, decision.keep);
    }
  }

  private async writeAndSave(target: Target, next: string): Promise<boolean> {
    if (next !== target.disk && !(await this.deps.vault.replace(target.path, target.disk, next))) return false;
    await this.saveBase(target, next);
    return true;
  }

  private saveBase(target: Target, base: string): Promise<void> {
    return this.deps.records.set(target.fileId, { path: target.path, base });
  }

  private async saveDiskCopy(target: Target, text: string): Promise<void> {
    const candidate = buildConflictPath({ path: target.path, label: "conflict-disk", timestampMs: this.deps.now(), fileId: target.fileId });
    const copyPath = await findFreePath(this.deps.vault, candidate);
    await this.deps.vault.replace(copyPath, null, text);
    this.deps.notify({ kind: "conflict-copy", path: target.path, copyPath });
  }
}

interface Target {
  fileId: string;
  path: string;
  opened: OpenedDoc;
  disk: string;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/plugin && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin
git commit -m "feat(core): reconcile disk and Y.Text per file with compare-and-swap writes"
```

---

### Task 10: Local change handling, index applier and the sync engine

**Files:**
- Create: `packages/plugin/src/core/localChanges.ts`, `packages/plugin/src/core/indexApplier.ts`, `packages/plugin/src/core/syncEngine.ts`
- Create: `packages/plugin/test/fakes/device.ts`
- Test: `packages/plugin/test/syncEngine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–9; `normalizeVaultPath`, `isSyncablePath`, `isWithinSizeLimit`, `buildIndexDocName`, timing constants (Task 1).
- Produces:
  - `class LocalChangeHandler { handleCreate(path): Promise<void>; handleModify(path): Promise<void>; handleRename(oldPath, newPath): Promise<void>; handleDelete(path): void; commitPendingDeletes(): Promise<void>; confirmPausedDeletes(): Promise<void>; restorePausedDeletes(): Promise<void> }`
  - `class IndexApplier { apply(): Promise<void> }`
  - `interface SyncTiming { diskWriteDebounceMs; indexPassDebounceMs; renamePairWindowMs; massDeleteWindowMs; massDeleteThreshold }`, `DEFAULT_TIMING: SyncTiming`
  - `interface SyncEngineDeps { vaultId; vault; storage; syncer; persistence; isOpenInEditor?: (path) => boolean; excludedPrefixes?: readonly string[]; now?: () => number; notify?: (notice: SyncNotice) => void; timing?: Partial<SyncTiming> }`
  - `class SyncEngine { constructor(deps); start(): Promise<void>; stop(): Promise<void>; idle(): Promise<void>; confirmPausedDeletes(): Promise<void>; restorePausedDeletes(): Promise<void> }`
  - `BOOTSTRAP_FLAG = "bootstrapped"`, `class EngineStoppedError extends Error`
  - Test harness `device.ts`: `TEST_VAULT_ID`, `FAST_TIMING`, `interface Device`, `createDevice(hub, name, options?)`, `startDevice(hub, name, options?)`, `restartDevice(hub, device)`, `settle(devices, rounds?)`, `fileDocName(device, path)`

- [ ] **Step 1: Write the device harness**

`packages/plugin/test/fakes/device.ts`:
```ts
import { buildFileDocName } from "@obsidian-crdt/shared";
import type { SyncNotice } from "../../src/core/notices";
import { SyncEngine, type SyncTiming } from "../../src/core/syncEngine";
import { FakeVault } from "./fakeVault";
import { type LoopbackHub, LoopbackSyncer } from "./loopback";
import { MemoryPersistence } from "./memoryPersistence";
import { MemoryStorage } from "./memoryStorage";

export const TEST_VAULT_ID = "test-vault-01";
export const FIXED_NOW = Date.UTC(2026, 9, 7, 12);
export const FAST_TIMING: SyncTiming = {
  diskWriteDebounceMs: 2,
  indexPassDebounceMs: 2,
  renamePairWindowMs: 20,
  massDeleteWindowMs: 60_000,
  massDeleteThreshold: 5,
};

export interface Device {
  name: string;
  vault: FakeVault;
  storage: MemoryStorage;
  persistence: MemoryPersistence;
  syncer: LoopbackSyncer;
  engine: SyncEngine;
  notices: SyncNotice[];
  openInEditor: Set<string>;
}

export interface DeviceOptions {
  files?: Record<string, string>;
  online?: boolean;
  reuse?: Device;
}

export function createDevice(hub: LoopbackHub, name: string, options: DeviceOptions = {}): Device {
  const vault = options.reuse?.vault ?? new FakeVault(options.files ?? {});
  const storage = options.reuse?.storage ?? new MemoryStorage();
  const persistence = options.reuse?.persistence ?? new MemoryPersistence();
  const syncer = new LoopbackSyncer(hub, { online: options.online ?? true });
  const notices: SyncNotice[] = [];
  const openInEditor = options.reuse?.openInEditor ?? new Set<string>();
  const engine = new SyncEngine({
    vaultId: TEST_VAULT_ID,
    vault,
    storage,
    syncer,
    persistence,
    isOpenInEditor: (path) => openInEditor.has(path),
    now: () => FIXED_NOW,
    notify: (notice) => notices.push(notice),
    timing: FAST_TIMING,
  });
  return { name, vault, storage, persistence, syncer, engine, notices, openInEditor };
}

export async function startDevice(hub: LoopbackHub, name: string, options: DeviceOptions = {}): Promise<Device> {
  const device = createDevice(hub, name, options);
  await device.engine.start();
  return device;
}

export async function restartDevice(hub: LoopbackHub, device: Device, options: { online?: boolean } = {}): Promise<Device> {
  await device.engine.stop();
  return startDevice(hub, device.name, { reuse: device, online: options.online });
}

/** Lets every device drain its queue and timers; repeated because one device's work wakes the others. */
export async function settle(devices: Device[], rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(devices.map((device) => device.engine.idle()));
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.renamePairWindowMs));
  }
}

export function fileDocName(device: Device, path: string): string {
  const fileId = [...device.storage.records.entries()].find(([, record]) => record.path === path)?.[0];
  if (!fileId) throw new Error(`${device.name} has no record for ${path}`);
  return buildFileDocName(TEST_VAULT_ID, fileId);
}
```

- [ ] **Step 2: Write the failing tests**

`packages/plugin/test/syncEngine.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, fileDocName, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function pair(): Promise<{ hub: LoopbackHub; a: Device; b: Device }> {
  const hub = new LoopbackHub();
  const a = await startDevice(hub, "A");
  const b = await startDevice(hub, "B");
  running.push(a, b);
  return { hub, a, b };
}

describe("SyncEngine — live changes between two devices", () => {
  it("propagates a new note", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("notes/new.md", "# hello");
    await settle([a, b]);
    expect(b.vault.files.get("notes/new.md")).toBe("# hello");
  });

  it("propagates edits", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("a.md", "one");
    await settle([a, b]);
    a.vault.externalWrite("a.md", "one two");
    await settle([a, b]);
    expect(b.vault.files.get("a.md")).toBe("one two");
  });

  it("merges concurrent edits to different lines", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("a.md", "l1\nl2\nl3\n");
    await settle([a, b]);
    a.vault.externalWrite("a.md", "L1\nl2\nl3\n");
    b.vault.externalWrite("a.md", "l1\nl2\nL3\n");
    await settle([a, b]);
    expect(a.vault.files.get("a.md")).toBe("L1\nl2\nL3\n");
    expect(b.vault.files.get("a.md")).toBe("L1\nl2\nL3\n");
  });

  it("propagates renames without changing the file id", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("old.md", "body");
    await settle([a, b]);
    const docName = fileDocName(a, "old.md");
    a.vault.externalRename("old.md", "folder/new.md");
    await settle([a, b]);
    expect(b.vault.files.has("old.md")).toBe(false);
    expect(b.vault.files.get("folder/new.md")).toBe("body");
    expect(fileDocName(b, "folder/new.md")).toBe(docName);
  });

  it("moves remote deletions to the trash", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("gone.md", "bye");
    await settle([a, b]);
    a.vault.externalDelete("gone.md");
    await settle([a, b]);
    expect(b.vault.files.has("gone.md")).toBe(false);
    expect(b.vault.trashed).toEqual([{ path: "gone.md", text: "bye" }]);
  });

  it("treats delete + create with the same content as a rename (git mv)", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("x.md", "same body");
    await settle([a, b]);
    const docName = fileDocName(a, "x.md");
    a.vault.externalDelete("x.md");
    a.vault.externalWrite("y.md", "same body");
    await settle([a, b]);
    expect(fileDocName(a, "y.md")).toBe(docName);
    expect(b.vault.files.get("y.md")).toBe("same body");
    expect(b.vault.trashed).toEqual([]);
  });

  it("ignores disk modify events for a file open in a bound editor (regression: editor save lag)", async () => {
    const { hub, a, b } = await pair();
    a.vault.externalWrite("open.md", "typed");
    await settle([a, b]);
    a.openInEditor.add("open.md");
    a.vault.externalWrite("open.md", "typ");
    await settle([a, b]);
    expect(hub.serverText(fileDocName(a, "open.md"))).toBe("typed");
  });

  it("pauses mass deletions until confirmed", async () => {
    const { a, b } = await pair();
    const paths = ["1.md", "2.md", "3.md", "4.md", "5.md"];
    for (const path of paths) a.vault.externalWrite(path, path);
    await settle([a, b]);
    for (const path of paths) a.vault.externalDelete(path);
    await settle([a, b]);
    expect(a.notices).toContainEqual({ kind: "mass-delete-paused", paths });
    expect(b.vault.files.size).toBe(5);
    await a.engine.confirmPausedDeletes();
    await settle([a, b]);
    expect(b.vault.files.size).toBe(0);
  });

  it("restores paused mass deletions on request", async () => {
    const { a, b } = await pair();
    const paths = ["1.md", "2.md", "3.md", "4.md", "5.md"];
    for (const path of paths) a.vault.externalWrite(path, `body ${path}`);
    await settle([a, b]);
    for (const path of paths) a.vault.externalDelete(path);
    await settle([a, b]);
    await a.engine.restorePausedDeletes();
    await settle([a, b]);
    expect(a.vault.files.get("3.md")).toBe("body 3.md");
    expect(b.vault.files.size).toBe(5);
  });

  // Review Focus 1
  it("keeps NFD file names byte-for-byte", async () => {
    const { a, b } = await pair();
    const nfd = "한글 노트.md".normalize("NFD");
    a.vault.externalWrite(nfd, "본문");
    await settle([a, b]);
    expect(b.vault.files.get(nfd)).toBe("본문");
    b.vault.externalWrite(nfd, "본문 수정");
    await settle([a, b]);
    expect([...a.vault.files.keys()]).toEqual([nfd]);
    expect(a.vault.files.get(nfd)).toBe("본문 수정");
  });

  // Review Focus 2
  it("does not pair empty files as a rename", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("empty-1.md", "");
    await settle([a, b]);
    const firstDoc = fileDocName(a, "empty-1.md");
    a.vault.externalDelete("empty-1.md");
    a.vault.externalWrite("empty-2.md", "");
    await settle([a, b]);
    expect(fileDocName(a, "empty-2.md")).not.toBe(firstDoc);
    expect(b.vault.files.has("empty-1.md")).toBe(false);
    expect(b.vault.files.get("empty-2.md")).toBe("");
  });

  // Review Focus 3
  it("starts syncing a file once it shrinks under the size limit", async () => {
    const { a, b } = await pair();
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    a.vault.externalWrite("big.md", huge);
    await settle([a, b]);
    expect(a.notices).toContainEqual({ kind: "file-too-large", path: "big.md" });
    expect(b.vault.files.has("big.md")).toBe(false);
    a.vault.externalWrite("big.md", "small now");
    await settle([a, b]);
    expect(b.vault.files.get("big.md")).toBe("small now");
  });

  // Review Focus 4
  it("treats a move into an excluded folder as a delete", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("note.md", "body");
    await settle([a, b]);
    a.vault.externalRename("note.md", ".trash/note.md");
    await settle([a, b]);
    expect(b.vault.files.has("note.md")).toBe(false);
    expect(b.vault.files.has(".trash/note.md")).toBe(false);
  });

  // Review Focus 5
  it("keeps a concurrent edit when the file is renamed elsewhere", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("draft.md", "first line\n");
    await settle([a, b]);
    a.vault.externalRename("draft.md", "final.md");
    b.vault.externalWrite("draft.md", "first line\nsecond line\n");
    await settle([a, b]);
    expect(a.vault.files.get("final.md")).toBe("first line\nsecond line\n");
    expect(b.vault.files.get("final.md")).toBe("first line\nsecond line\n");
    expect(b.vault.files.has("draft.md")).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/syncEngine.test.ts`
Expected: FAIL — `../../src/core/syncEngine` not found.

- [ ] **Step 4: Implement the local change handler**

`packages/plugin/src/core/localChanges.ts`:
```ts
import { isWithinSizeLimit } from "@obsidian-crdt/shared";
import { DISK_ORIGIN, type DocManager } from "./docManager";
import type { FileReconciler } from "./fileReconciler";
import type { MassDeleteGuard } from "./massDeleteGuard";
import type { SyncNotice } from "./notices";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";
import { applyMinimalDiff } from "./textDiff";
import type { VaultIndex } from "./vaultIndex";

export interface LocalChangeDeps {
  vault: VaultPort;
  index: VaultIndex;
  records: RecordStore;
  docs: DocManager;
  reconciler: FileReconciler;
  guard: MassDeleteGuard;
  now: () => number;
  notify: (notice: SyncNotice) => void;
  isEligible: (path: string) => boolean;
  isOpenInEditor: (path: string) => boolean;
}

interface PendingDelete {
  fileId: string;
  path: string;
  base: string | null;
}

/** Turns this device's vault events into index and document changes (spec §4.4). */
export class LocalChangeHandler {
  private readonly pendingDeletes = new Map<string, PendingDelete>();
  private pausedDeletes: PendingDelete[] = [];

  constructor(private readonly deps: LocalChangeDeps) {}

  async handleCreate(path: string): Promise<void> {
    if (!this.deps.isEligible(path)) return;
    const knownId = this.deps.records.findIdByPath(path);
    if (knownId) return this.deps.reconciler.reconcile(knownId);
    const live = this.deps.index.findLiveByPath(path);
    if (live) return this.adoptRemoteEntry(live.fileId, path);
    const text = await this.deps.vault.read(path);
    if (text === null) return;
    if (!isWithinSizeLimit(text)) return this.deps.notify({ kind: "file-too-large", path });
    const renamed = this.takePendingDeleteWithBase(text);
    if (renamed) return this.moveTracked(renamed.fileId, path);
    await this.registerNew(path, text);
  }

  async handleModify(path: string): Promise<void> {
    if (!this.deps.isEligible(path) || this.deps.isOpenInEditor(path)) return;
    const fileId = this.deps.records.findIdByPath(path);
    if (fileId) return this.deps.reconciler.reconcile(fileId);
    return this.handleCreate(path);
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const fileId = this.deps.records.findIdByPath(oldPath);
    if (!fileId) return this.handleCreate(newPath);
    if (!this.deps.isEligible(newPath)) return this.handleDelete(oldPath);
    await this.moveTracked(fileId, newPath);
  }

  /** Deletes wait for the rename-pair window; the engine then calls commitPendingDeletes(). */
  handleDelete(path: string): void {
    const fileId = this.deps.records.findIdByPath(path);
    if (!fileId || this.pendingDeletes.has(fileId)) return;
    this.pendingDeletes.set(fileId, { fileId, path, base: this.deps.records.get(fileId)?.base ?? null });
  }

  async commitPendingDeletes(): Promise<void> {
    const batch = [...this.pendingDeletes.values()];
    this.pendingDeletes.clear();
    if (batch.length === 0) return;
    if (this.pausedDeletes.length > 0 || this.deps.guard.record(batch.length)) {
      this.pausedDeletes.push(...batch);
      this.deps.notify({ kind: "mass-delete-paused", paths: this.pausedDeletes.map((item) => item.path) });
      return;
    }
    for (const item of batch) await this.commitDelete(item);
  }

  async confirmPausedDeletes(): Promise<void> {
    const paused = this.takePaused();
    for (const item of paused) await this.commitDelete(item);
  }

  async restorePausedDeletes(): Promise<void> {
    const paused = this.takePaused();
    for (const item of paused) {
      const { text } = await this.deps.docs.open(item.fileId);
      await this.deps.vault.replace(item.path, null, text.toString());
    }
  }

  private takePaused(): PendingDelete[] {
    const paused = this.pausedDeletes;
    this.pausedDeletes = [];
    this.deps.guard.reset();
    return paused;
  }

  private async commitDelete(item: PendingDelete): Promise<void> {
    if ((await this.deps.vault.read(item.path)) !== null) return; // the file came back
    this.deps.index.markDeleted(item.fileId);
    await this.deps.records.delete(item.fileId);
  }

  private async adoptRemoteEntry(fileId: string, path: string): Promise<void> {
    await this.deps.records.set(fileId, { path, base: null });
    await this.deps.reconciler.reconcile(fileId);
  }

  private async moveTracked(fileId: string, newPath: string): Promise<void> {
    const record = this.deps.records.get(fileId);
    this.deps.index.rename(fileId, newPath);
    await this.deps.records.set(fileId, { path: newPath, base: record?.base ?? null });
    await this.deps.reconciler.reconcile(fileId);
  }

  private async registerNew(path: string, text: string): Promise<void> {
    const fileId = this.deps.index.register(path, this.deps.now());
    const opened = await this.deps.docs.open(fileId);
    applyMinimalDiff(opened.text, text, DISK_ORIGIN);
    await this.deps.records.set(fileId, { path, base: text });
  }

  /** Empty files are never paired: any two empty notes would look like a rename. */
  private takePendingDeleteWithBase(text: string): PendingDelete | null {
    if (text === "") return null;
    for (const item of this.pendingDeletes.values()) {
      if (item.base === text) {
        this.pendingDeletes.delete(item.fileId);
        return item;
      }
    }
    return null;
  }
}
```

- [ ] **Step 5: Implement the index applier**

`packages/plugin/src/core/indexApplier.ts`:
```ts
import type { DocManager } from "./docManager";
import type { FileReconciler } from "./fileReconciler";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";
import type { IndexEntry, VaultIndex } from "./vaultIndex";

export interface IndexApplierDeps {
  vault: VaultPort;
  index: VaultIndex;
  records: RecordStore;
  docs: DocManager;
  reconciler: FileReconciler;
  isEligible: (path: string) => boolean;
  /** Called when a document that was not yet synced becomes synced, so another pass can create it. */
  requestPass: () => void;
}

/** Makes this device's disk match the index: deletions, then moves, then creations (spec §4.4). */
export class IndexApplier {
  constructor(private readonly deps: IndexApplierDeps) {}

  async apply(): Promise<void> {
    const plan = this.deps.index.planCollisionResolution();
    if (plan.length > 0) this.deps.index.applyReassignments(plan);
    const entries = this.deps.index.entries();
    for (const entry of entries) if (entry.deleted) await this.applyDeletion(entry);
    for (const entry of entries) if (!entry.deleted) await this.applyMove(entry);
    for (const entry of entries) if (!entry.deleted) await this.applyCreation(entry);
  }

  private async applyDeletion(entry: IndexEntry): Promise<void> {
    const record = this.deps.records.get(entry.fileId);
    if (!record) return;
    await this.deps.records.delete(entry.fileId); // first, so the resulting delete event is ignored
    if ((await this.deps.vault.read(record.path)) !== null) await this.deps.vault.trash(record.path);
  }

  private async applyMove(entry: IndexEntry): Promise<void> {
    const record = this.deps.records.get(entry.fileId);
    if (!record || record.path === entry.path) return;
    if (!this.deps.isEligible(entry.path)) return;
    if ((await this.deps.vault.read(entry.path)) !== null) return; // target busy; a later pass retries
    const sourceExists = (await this.deps.vault.read(record.path)) !== null;
    await this.deps.records.set(entry.fileId, { path: entry.path, base: record.base });
    if (sourceExists) await this.deps.vault.rename(record.path, entry.path);
  }

  private async applyCreation(entry: IndexEntry): Promise<void> {
    if (this.deps.records.get(entry.fileId) || !this.deps.isEligible(entry.path)) return;
    if (this.deps.records.findIdByPath(entry.path)) return; // another file still sits there; wait for its move
    const opened = await this.deps.docs.open(entry.fileId);
    if (!opened.sync.isSynced()) {
      void opened.sync.whenSynced().then(this.deps.requestPass);
      return;
    }
    if ((await this.deps.vault.read(entry.path)) !== null) return this.adoptExisting(entry);
    const text = opened.text.toString();
    await this.deps.records.set(entry.fileId, { path: entry.path, base: text });
    if (!(await this.deps.vault.replace(entry.path, null, text))) await this.adoptExisting(entry);
  }

  /** An untracked local file already uses the path: server text wins, the local text is kept as a copy. */
  private async adoptExisting(entry: IndexEntry): Promise<void> {
    await this.deps.records.set(entry.fileId, { path: entry.path, base: null });
    await this.deps.reconciler.reconcile(entry.fileId);
  }
}
```

- [ ] **Step 6: Implement the engine**

`packages/plugin/src/core/syncEngine.ts`:
```ts
import * as Y from "yjs";
import {
  buildIndexDocName,
  DISK_WRITE_DEBOUNCE_MS,
  INDEX_PASS_DEBOUNCE_MS,
  isSyncablePath,
  MASS_DELETE_THRESHOLD,
  MASS_DELETE_WINDOW_MS,
  normalizeVaultPath,
  RENAME_PAIR_WINDOW_MS,
} from "@obsidian-crdt/shared";
import { DocManager } from "./docManager";
import { FileReconciler } from "./fileReconciler";
import { IndexApplier } from "./indexApplier";
import { LocalChangeHandler } from "./localChanges";
import { MassDeleteGuard } from "./massDeleteGuard";
import type { SyncNotice } from "./notices";
import type { DocPersistence, DocSyncer, DocSyncHandle, PersistedDoc, StoragePort, VaultEvent, VaultPort } from "./ports";
import { RecordStore } from "./recordStore";
import { KeyedDebouncer, SerialQueue, waitUntil } from "./scheduling";
import { VaultIndex } from "./vaultIndex";

export const BOOTSTRAP_FLAG = "bootstrapped";

export interface SyncTiming {
  diskWriteDebounceMs: number;
  indexPassDebounceMs: number;
  renamePairWindowMs: number;
  massDeleteWindowMs: number;
  massDeleteThreshold: number;
}

export const DEFAULT_TIMING: SyncTiming = {
  diskWriteDebounceMs: DISK_WRITE_DEBOUNCE_MS,
  indexPassDebounceMs: INDEX_PASS_DEBOUNCE_MS,
  renamePairWindowMs: RENAME_PAIR_WINDOW_MS,
  massDeleteWindowMs: MASS_DELETE_WINDOW_MS,
  massDeleteThreshold: MASS_DELETE_THRESHOLD,
};

export interface SyncEngineDeps {
  vaultId: string;
  vault: VaultPort;
  storage: StoragePort;
  syncer: DocSyncer;
  persistence: DocPersistence;
  isOpenInEditor?: (path: string) => boolean;
  excludedPrefixes?: readonly string[];
  now?: () => number;
  notify?: (notice: SyncNotice) => void;
  timing?: Partial<SyncTiming>;
}

export class EngineStoppedError extends Error {
  constructor() {
    super("sync engine stopped");
    this.name = "EngineStoppedError";
  }
}

interface Wiring {
  records: RecordStore;
  docs: DocManager;
  index: VaultIndex;
  indexSync: DocSyncHandle;
  indexPersisted: PersistedDoc;
  indexDoc: Y.Doc;
  reconciler: FileReconciler;
  local: LocalChangeHandler;
  applier: IndexApplier;
}

export class SyncEngine {
  private readonly timing: SyncTiming;
  private readonly now: () => number;
  private readonly notify: (notice: SyncNotice) => void;
  private readonly isOpenInEditor: (path: string) => boolean;
  private readonly queue = new SerialQueue((error) => this.reportFailure(error));
  private readonly debouncer = new KeyedDebouncer();
  private readonly disposers: Array<() => void> = [];
  private wiring: Wiring | null = null;
  private stopped = false;
  private signalStopped: () => void = () => {};
  private readonly stoppedSignal = new Promise<void>((resolve) => {
    this.signalStopped = resolve;
  });

  constructor(private readonly deps: SyncEngineDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.notify = deps.notify ?? (() => {});
    this.isOpenInEditor = deps.isOpenInEditor ?? (() => false);
  }

  async start(): Promise<void> {
    const wiring = await this.wire();
    if (!(await this.deps.storage.getFlag(BOOTSTRAP_FLAG))) await this.waitForFirstSync(wiring.indexSync);
    this.disposers.push(wiring.index.onRemoteChange(() => this.scheduleIndexPass()));
    this.disposers.push(this.deps.vault.onEvent((event) => this.route(event)));
    this.scheduleIndexPass();
    await this.deps.storage.setFlag(BOOTSTRAP_FLAG, true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.signalStopped();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.debouncer.cancelAll();
    const wiring = this.wiring;
    this.wiring = null;
    if (!wiring) return;
    await wiring.docs.closeAll();
    wiring.indexSync.destroy();
    wiring.indexPersisted.destroy();
    wiring.indexDoc.destroy();
  }

  /** Resolves when no timers are pending and the queue is empty. Used by tests and shutdown. */
  async idle(): Promise<void> {
    const quiet = () => this.debouncer.size === 0 && this.queue.isIdle;
    do {
      await waitUntil(quiet);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (!quiet());
  }

  confirmPausedDeletes(): Promise<void> {
    return this.queue.enqueue(() => this.requireWiring().local.confirmPausedDeletes());
  }

  restorePausedDeletes(): Promise<void> {
    return this.queue.enqueue(() => this.requireWiring().local.restorePausedDeletes());
  }

  private async wire(): Promise<Wiring> {
    const { vaultId, storage, syncer, persistence, vault } = this.deps;
    const records = await RecordStore.load(storage);
    const docs = new DocManager({ vaultId, syncer, persistence, onTextChanged: (id) => this.scheduleTextFlush(id) });
    const indexDoc = new Y.Doc();
    const indexName = buildIndexDocName(vaultId);
    const indexPersisted = await persistence.attach(indexName, indexDoc);
    const indexSync = syncer.connect(indexName, indexDoc);
    const index = new VaultIndex(indexDoc);
    const isEligible = (path: string) => isSyncablePath(path, this.deps.excludedPrefixes);
    const reconciler = new FileReconciler({ vault, records, docs, now: this.now, notify: this.notify, requestRetry: (id) => this.scheduleTextFlush(id) });
    const guard = new MassDeleteGuard({ threshold: this.timing.massDeleteThreshold, windowMs: this.timing.massDeleteWindowMs, now: this.now });
    const local = new LocalChangeHandler({ vault, index, records, docs, reconciler, guard, now: this.now, notify: this.notify, isEligible, isOpenInEditor: this.isOpenInEditor });
    const applier = new IndexApplier({ vault, index, records, docs, reconciler, isEligible, requestPass: () => this.scheduleIndexPass() });
    this.wiring = { records, docs, index, indexSync, indexPersisted, indexDoc, reconciler, local, applier };
    return this.wiring;
  }

  private async waitForFirstSync(indexSync: DocSyncHandle): Promise<void> {
    if (!indexSync.isSynced()) this.notify({ kind: "waiting-for-first-sync" });
    await Promise.race([indexSync.whenSynced(), this.stoppedSignal]);
    if (this.stopped) throw new EngineStoppedError();
  }

  private route(event: VaultEvent): void {
    if (this.stopped) return;
    const local = this.requireWiring().local;
    const path = normalizeVaultPath(event.path);
    switch (event.type) {
      case "create":
        void this.queue.enqueue(() => local.handleCreate(path));
        return;
      case "modify":
        void this.queue.enqueue(() => local.handleModify(path));
        return;
      case "rename":
        // A move into an excluded folder becomes a pending delete, so the commit must be scheduled here too.
        void this.queue.enqueue(() => local.handleRename(normalizeVaultPath(event.oldPath), path));
        this.scheduleDeleteCommit();
        return;
      case "delete":
        void this.queue.enqueue(async () => local.handleDelete(path));
        this.scheduleDeleteCommit();
        return;
    }
  }

  private scheduleDeleteCommit(): void {
    this.debouncer.schedule("deletes", this.timing.renamePairWindowMs, () => {
      void this.queue.enqueue(() => this.requireWiring().local.commitPendingDeletes());
    });
  }

  private scheduleTextFlush(fileId: string): void {
    if (this.stopped) return;
    this.debouncer.schedule(`text:${fileId}`, this.timing.diskWriteDebounceMs, () => {
      void this.queue.enqueue(() => this.flushRemoteText(fileId));
    });
  }

  private async flushRemoteText(fileId: string): Promise<void> {
    const wiring = this.requireWiring();
    const record = wiring.records.get(fileId);
    if (!record || this.isOpenInEditor(record.path)) return; // the editor binding owns open files (spec §4.1)
    await wiring.reconciler.reconcile(fileId);
  }

  private scheduleIndexPass(): void {
    if (this.stopped) return;
    this.debouncer.schedule("index", this.timing.indexPassDebounceMs, () => {
      void this.queue.enqueue(() => this.requireWiring().applier.apply());
    });
  }

  private requireWiring(): Wiring {
    if (!this.wiring) throw new EngineStoppedError();
    return this.wiring;
  }

  /** Queue boundary: one failed task must not stop syncing other files. */
  private reportFailure(error: unknown): void {
    if (this.stopped) return;
    this.notify({ kind: "task-failed", message: error instanceof Error ? error.message : String(error) });
  }
}
```

> If `syncEngine.ts` exceeds 300 LOC after formatting, move `wire()` into `src/core/engineWiring.ts` as `createWiring(deps, callbacks): Promise<Wiring>`.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run packages/plugin && npm run typecheck`
Expected: PASS. If a test fails, debug with superpowers:systematic-debugging before changing assertions — the assertions encode spec behaviour.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin
git commit -m "feat(core): sync vault events and index changes between devices"
```

---

### Task 11: Startup scan, bootstrap, restart and convergence

**Files:**
- Create: `packages/plugin/src/core/startupScan.ts`, `packages/plugin/test/fakes/random.ts`
- Modify: `packages/plugin/src/core/syncEngine.ts` (`start()` and `wire()`)
- Test: `packages/plugin/test/startupAndRecovery.test.ts`, `packages/plugin/test/convergence.test.ts`

**Interfaces:**
- Consumes: `LocalChangeHandler`, `IndexApplier`, `FileReconciler`, `RecordStore` (Tasks 9–10).
- Produces: `class StartupScan { constructor(deps: StartupScanDeps); run(): Promise<void> }` with `StartupScanDeps { vault; records; reconciler; local; applier; isEligible }`; `mulberry32(seed: number): () => number` (test helper).

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/startupAndRecovery.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { EngineStoppedError } from "../src/core/syncEngine";
import { LoopbackHub } from "./fakes/loopback";
import { createDevice, type Device, fileDocName, restartDevice, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function start(hub: LoopbackHub, name: string, files: Record<string, string> = {}): Promise<Device> {
  const device = await startDevice(hub, name, { files });
  running.push(device);
  return device;
}

describe("startup scan and bootstrap", () => {
  it("registers files that already exist on the first device", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "hello" });
    await settle([a]);
    expect(hub.serverText(fileDocName(a, "a.md"))).toBe("hello");
  });

  it("does not double text when a second device already has the same file (regression: bootstrap doubling)", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "hello" });
    await settle([a]);
    const b = await start(hub, "B", { "a.md": "hello" });
    await settle([a, b]);
    expect(hub.serverText(fileDocName(a, "a.md"))).toBe("hello");
    expect(b.vault.files.get("a.md")).toBe("hello");
    expect(fileDocName(b, "a.md")).toBe(fileDocName(a, "a.md"));
    expect(b.notices.filter((notice) => notice.kind === "conflict-copy")).toEqual([]);
  });

  it("keeps the server text and saves a copy when a new device has a stale file", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "new" });
    await settle([a]);
    const b = await start(hub, "B", { "a.md": "old" });
    await settle([a, b]);
    expect(b.vault.files.get("a.md")).toBe("new");
    expect(b.vault.files.get("a (conflict-disk 2026-10-07 " + fileDocName(a, "a.md").split("/")[1]!.slice(0, 6) + ").md")).toBe("old");
    expect(hub.serverText(fileDocName(a, "a.md"))).toBe("new");
  });

  it("waits for the server on the very first start", async () => {
    const hub = new LoopbackHub();
    const device = createDevice(hub, "A", { online: false });
    running.push(device);
    let started = false;
    const starting = device.engine.start().then(() => (started = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(false);
    expect(device.notices).toContainEqual({ kind: "waiting-for-first-sync" });
    device.syncer.setOnline(true);
    await starting;
  });

  it("rejects start with EngineStoppedError when stopped while waiting", async () => {
    const device = createDevice(new LoopbackHub(), "A", { online: false });
    const starting = device.engine.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await device.engine.stop();
    await expect(starting).rejects.toBeInstanceOf(EngineStoppedError);
  });

  it("starts offline after the first sync and catches up later", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "v1" });
    await settle([a]);
    const restarted = await restartDevice(hub, a, { online: false });
    running.splice(running.indexOf(a), 1, restarted);
    restarted.vault.externalWrite("a.md", "v1 offline edit");
    await settle([restarted]);
    restarted.syncer.setOnline(true);
    await settle([restarted]);
    expect(hub.serverText(fileDocName(restarted, "a.md"))).toBe("v1 offline edit");
  });
});

describe("recovery after a device was closed", () => {
  it("does not revert remote edits made while the device was closed (regression: closed-device revert)", async () => {
    const hub = new LoopbackHub();
    const desktop = await start(hub, "desktop", { "a.md": "v1" });
    const phone = await start(hub, "phone");
    await settle([desktop, phone]);
    await desktop.engine.stop();
    running.splice(running.indexOf(desktop), 1);

    phone.vault.externalWrite("a.md", "v1 + phone edit");
    await settle([phone]);

    const reopened = await restartDevice(hub, desktop);
    running.push(reopened);
    await settle([reopened, phone]);
    expect(reopened.vault.files.get("a.md")).toBe("v1 + phone edit");
    expect(hub.serverText(fileDocName(phone, "a.md"))).toBe("v1 + phone edit");
  });

  it("merges disk edits made while closed with remote edits", async () => {
    const hub = new LoopbackHub();
    const desktop = await start(hub, "desktop", { "a.md": "l1\nl2\n" });
    const phone = await start(hub, "phone");
    await settle([desktop, phone]);
    await desktop.engine.stop();
    running.splice(running.indexOf(desktop), 1);

    phone.vault.externalWrite("a.md", "l1\nl2\nphone\n");
    await settle([phone]);
    desktop.vault.externalWrite("a.md", "L1\nl2\n");

    const reopened = await restartDevice(hub, desktop);
    running.push(reopened);
    await settle([reopened, phone]);
    expect(reopened.vault.files.get("a.md")).toBe("L1\nl2\nphone\n");
    expect(phone.vault.files.get("a.md")).toBe("L1\nl2\nphone\n");
  });

  it("propagates files deleted while the device was closed", async () => {
    const hub = new LoopbackHub();
    const desktop = await start(hub, "desktop", { "a.md": "x" });
    const phone = await start(hub, "phone");
    await settle([desktop, phone]);
    await desktop.engine.stop();
    running.splice(running.indexOf(desktop), 1);
    desktop.vault.externalDelete("a.md");

    const reopened = await restartDevice(hub, desktop);
    running.push(reopened);
    await settle([reopened, phone]);
    expect(phone.vault.files.has("a.md")).toBe(false);
  });

  it("creates exactly one conflict copy for the same path created offline on two devices (regression: offline same path)", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A");
    const b = await start(hub, "B");
    await settle([a, b]);
    a.syncer.setOnline(false);
    b.syncer.setOnline(false);
    a.vault.externalWrite("Daily.md", "from A");
    b.vault.externalWrite("Daily.md", "from B");
    await settle([a, b]);
    a.syncer.setOnline(true);
    b.syncer.setOnline(true);
    await settle([a, b], 12);

    const pathsA = [...a.vault.files.keys()].sort();
    const pathsB = [...b.vault.files.keys()].sort();
    expect(pathsA).toEqual(pathsB);
    expect(pathsA).toHaveLength(2);
    expect(pathsA.filter((path) => path.includes("(conflict "))).toHaveLength(1);
    for (const path of pathsA) expect(a.vault.files.get(path)).toBe(b.vault.files.get(path));
    expect(new Set(pathsA.map((path) => a.vault.files.get(path)))).toEqual(new Set(["from A", "from B"]));
  });
});
```

`packages/plugin/test/fakes/random.ts`:
```ts
/** Small seeded PRNG so convergence runs are reproducible. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

`packages/plugin/test/convergence.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, fileDocName, settle, startDevice } from "./fakes/device";
import { mulberry32 } from "./fakes/random";

const WORDS = ["alpha", "beta", "가나", "😀", "delta", "\n"];
const STEPS = 40;
const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function insertRandomWord(random: () => number, text: string): string {
  const chars = [...text];
  const at = Math.floor(random() * (chars.length + 1));
  chars.splice(at, 0, pick(random, WORDS));
  return chars.join("");
}

async function runScenario(seed: number): Promise<Device[]> {
  const random = mulberry32(seed);
  const hub = new LoopbackHub();
  const devices = [await startDevice(hub, "A"), await startDevice(hub, "B"), await startDevice(hub, "C")];
  running.push(...devices);
  let created = 0;
  for (let step = 0; step < STEPS; step++) {
    const device = pick(random, devices);
    const roll = random();
    const paths = [...device.vault.files.keys()];
    if (roll < 0.15 || paths.length === 0) {
      device.vault.externalWrite(`${device.name}-${created++}.md`, pick(random, WORDS));
    } else if (roll < 0.85) {
      const path = pick(random, paths);
      device.vault.externalWrite(path, insertRandomWord(random, device.vault.files.get(path) ?? ""));
    } else {
      device.syncer.setOnline(!device.syncer["online"]);
    }
    if (random() < 0.3) await settle(devices, 2);
  }
  for (const device of devices) device.syncer.setOnline(true);
  await settle(devices, 16);
  return devices;
}

describe("convergence", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`converges for seed ${seed}`, async () => {
      const devices = await runScenario(seed);
      const [first, ...rest] = devices as [Device, ...Device[]];
      const expected = Object.fromEntries([...first.vault.files.entries()].sort());
      for (const device of rest) {
        expect(Object.fromEntries([...device.vault.files.entries()].sort())).toEqual(expected);
      }
      for (const [path, text] of first.vault.files) {
        expect(text).not.toMatch(/\uFFFD/);
        expect(fileDocName(first, path)).toBeTruthy();
      }
    });
  }
});
```

> `device.syncer["online"]` reads a private field for brevity in the test. If the typechecker rejects it, add `get isOnline(): boolean { return this.online; }` to `LoopbackSyncer` and use that.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/startupAndRecovery.test.ts packages/plugin/test/convergence.test.ts`
Expected: FAIL — e.g. `registers files that already exist on the first device` fails because existing files are never scanned.

- [ ] **Step 3: Implement the startup scan**

`packages/plugin/src/core/startupScan.ts`:
```ts
import { normalizeVaultPath } from "@obsidian-crdt/shared";
import type { FileReconciler } from "./fileReconciler";
import type { IndexApplier } from "./indexApplier";
import type { LocalChangeHandler } from "./localChanges";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";

export interface StartupScanDeps {
  vault: VaultPort;
  records: RecordStore;
  reconciler: FileReconciler;
  local: LocalChangeHandler;
  applier: IndexApplier;
  isEligible: (path: string) => boolean;
}

/** Catches up with everything that happened while the plugin was not running (spec §4.3, §4.5). */
export class StartupScan {
  constructor(private readonly deps: StartupScanDeps) {}

  async run(): Promise<void> {
    const diskPaths = (await this.deps.vault.listFiles()).map(normalizeVaultPath).filter(this.deps.isEligible);
    const onDisk = new Set(diskPaths);
    for (const [, record] of this.deps.records.entries()) {
      if (!onDisk.has(record.path)) this.deps.local.handleDelete(record.path);
    }
    for (const path of diskPaths) {
      const fileId = this.deps.records.findIdByPath(path);
      if (fileId) await this.deps.reconciler.reconcile(fileId);
      else await this.deps.local.handleCreate(path);
    }
    await this.deps.applier.apply();
  }
}
```

- [ ] **Step 4: Wire the scan into the engine**

In `packages/plugin/src/core/syncEngine.ts`:

Add the import:
```ts
import { StartupScan } from "./startupScan";
```

Add `scan: StartupScan;` to the `Wiring` interface, and in `wire()` replace the line that assigns `this.wiring` with:
```ts
    const scan = new StartupScan({ vault, records, reconciler, local, applier, isEligible });
    this.wiring = { records, docs, index, indexSync, indexPersisted, indexDoc, reconciler, local, applier, scan };
```

Replace `start()` with:
```ts
  async start(): Promise<void> {
    const wiring = await this.wire();
    if (!(await this.deps.storage.getFlag(BOOTSTRAP_FLAG))) await this.waitForFirstSync(wiring.indexSync);
    this.disposers.push(wiring.index.onRemoteChange(() => this.scheduleIndexPass()));
    this.disposers.push(this.deps.vault.onEvent((event) => this.route(event)));
    await this.queue.enqueue(() => wiring.scan.run());
    this.scheduleDeleteCommit();
    if (this.stopped) throw new EngineStoppedError();
    await this.deps.storage.setFlag(BOOTSTRAP_FLAG, true);
  }
```

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm run check`
Expected: all tests PASS (including Task 10's), typecheck exits 0. If a convergence seed fails, keep the seed, use superpowers:systematic-debugging, and add the minimal reproduction as its own regression test before fixing.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin
git commit -m "feat(core): scan on startup, bootstrap safely and converge after offline work"
```

---

### Task 12: Hocuspocus syncer and end-to-end tests against the real server

**Files:**
- Create: `packages/plugin/src/core/serverUrl.ts`, `packages/plugin/src/core/hocuspocusSyncer.ts`
- Test: `packages/plugin/test/serverUrl.test.ts`, `packages/plugin/test/endToEnd.test.ts`

**Interfaces:**
- Consumes: `DocSyncer`, `DocSyncHandle` (Task 8); `SyncEngine`, `EngineStoppedError` (Task 10); `createSyncServer`, `openDatabase`, `DocumentStore`, `TokenStore`, `createJsonLogger` from `@obsidian-crdt/server` (Task 3); `RECONNECT_MAX_DELAY_MS` (Task 1).
- Produces:
  - `assertSecureServerUrl(url: string): void`, `class InsecureServerUrlError extends Error`
  - `type ConnectionStatus = "connecting" | "connected" | "disconnected"`
  - `class HocuspocusSyncer implements DocSyncer { constructor(options: HocuspocusSyncerOptions); connect(docName, doc): DocSyncHandle; pause(): void; resume(): void; destroy(): void }`
  - `interface HocuspocusSyncerOptions { url: string; token: string; onAuthFailed: () => void; onStatus?: (status: ConnectionStatus) => void }`

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/serverUrl.test.ts`:
```ts
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
```

`packages/plugin/test/endToEnd.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { createJsonLogger, createSyncServer, DocumentStore, openDatabase, TokenStore } from "@obsidian-crdt/server";
import { HocuspocusSyncer } from "../src/core/hocuspocusSyncer";
import type { SyncNotice } from "../src/core/notices";
import { EngineStoppedError, SyncEngine } from "../src/core/syncEngine";
import { FakeVault } from "./fakes/fakeVault";
import { FAST_TIMING, TEST_VAULT_ID } from "./fakes/device";
import { MemoryPersistence } from "./fakes/memoryPersistence";
import { MemoryStorage } from "./fakes/memoryStorage";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually(assertion: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function startServer() {
  const db = openDatabase(":memory:");
  const tokens = new TokenStore(db);
  const logs: string[] = [];
  const server = createSyncServer({
    port: 0,
    address: "127.0.0.1",
    documents: new DocumentStore(db),
    tokens,
    logger: createJsonLogger((line) => logs.push(line)),
    storeDebounceMs: 0,
  });
  await server.listen();
  cleanups.push(() => server.destroy());
  return { url: `ws://127.0.0.1:${server.address.port}`, token: tokens.issue(TEST_VAULT_ID).token, logs };
}

function device(url: string, token: string, files: Record<string, string> = {}) {
  const vault = new FakeVault(files);
  const notices: SyncNotice[] = [];
  let authFailures = 0;
  let engine: SyncEngine | null = null;
  const syncer = new HocuspocusSyncer({
    url,
    token,
    onAuthFailed: () => {
      authFailures++;
      void engine?.stop();
    },
  });
  engine = new SyncEngine({
    vaultId: TEST_VAULT_ID,
    vault,
    storage: new MemoryStorage(),
    syncer,
    persistence: new MemoryPersistence(),
    notify: (notice) => notices.push(notice),
    timing: FAST_TIMING,
  });
  const started = engine;
  cleanups.push(async () => {
    await started.stop();
    syncer.destroy();
  });
  return { vault, notices, syncer, engine: started, authFailures: () => authFailures };
}

describe("end to end with the real server", () => {
  it("syncs create, edit, rename and delete between two devices", async () => {
    const { url, token } = await startServer();
    const a = device(url, token, { "a.md": "hello" });
    const b = device(url, token);
    await a.engine.start();
    await b.engine.start();

    await eventually(() => expect(b.vault.files.get("a.md")).toBe("hello"));
    a.vault.externalWrite("a.md", "hello world");
    await eventually(() => expect(b.vault.files.get("a.md")).toBe("hello world"));
    b.vault.externalRename("a.md", "renamed.md");
    await eventually(() => expect([...a.vault.files.keys()]).toEqual(["renamed.md"]));
    a.vault.externalDelete("renamed.md");
    await eventually(() => expect(b.vault.files.size).toBe(0));
  });

  it("merges edits made while one device was disconnected", async () => {
    const { url, token } = await startServer();
    const a = device(url, token, { "a.md": "l1\nl2\n" });
    const b = device(url, token);
    await a.engine.start();
    await b.engine.start();
    await eventually(() => expect(b.vault.files.get("a.md")).toBe("l1\nl2\n"));

    a.syncer.pause();
    a.vault.externalWrite("a.md", "L1\nl2\n");
    b.vault.externalWrite("a.md", "l1\nl2\nfrom b\n");
    await a.engine.idle();
    a.syncer.resume();

    await eventually(() => {
      expect(a.vault.files.get("a.md")).toBe("L1\nl2\nfrom b\n");
      expect(b.vault.files.get("a.md")).toBe("L1\nl2\nfrom b\n");
    });
  });

  it("stops after an authentication failure and does not keep retrying", async () => {
    const { url, logs } = await startServer();
    const bad = device(url, "wrong-token");
    await expect(bad.engine.start()).rejects.toBeInstanceOf(EngineStoppedError);
    expect(bad.authFailures()).toBe(1);
    const rejectionsNow = logs.filter((line) => line.includes("auth.rejected")).length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(logs.filter((line) => line.includes("auth.rejected")).length).toBe(rejectionsNow);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/serverUrl.test.ts packages/plugin/test/endToEnd.test.ts`
Expected: FAIL — `serverUrl` / `hocuspocusSyncer` modules not found.

- [ ] **Step 3: Implement**

`packages/plugin/src/core/serverUrl.ts`:
```ts
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export class InsecureServerUrlError extends Error {
  constructor(url: string) {
    super(`server URL must use wss:// (ws:// only for localhost): "${url}"`);
    this.name = "InsecureServerUrlError";
  }
}

export function assertSecureServerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InsecureServerUrlError(url);
  }
  if (parsed.protocol === "wss:") return;
  if (parsed.protocol === "ws:" && LOCAL_HOSTS.includes(parsed.hostname)) return;
  throw new InsecureServerUrlError(url);
}
```

`packages/plugin/src/core/hocuspocusSyncer.ts`:
```ts
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { RECONNECT_MAX_DELAY_MS } from "@obsidian-crdt/shared";
import type * as Y from "yjs";
import type { DocSyncer, DocSyncHandle } from "./ports";
import { assertSecureServerUrl } from "./serverUrl";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface HocuspocusSyncerOptions {
  url: string;
  token: string;
  onAuthFailed: () => void;
  onStatus?: (status: ConnectionStatus) => void;
}

/** All documents share one WebSocket (multiplexing). */
export class HocuspocusSyncer implements DocSyncer {
  private readonly socket: HocuspocusProviderWebsocket;
  private readonly providers = new Set<HocuspocusProvider>();
  private authFailed = false;

  constructor(private readonly options: HocuspocusSyncerOptions) {
    assertSecureServerUrl(options.url);
    this.socket = new HocuspocusProviderWebsocket({
      url: options.url,
      maxDelay: RECONNECT_MAX_DELAY_MS,
      onStatus: ({ status }) => options.onStatus?.(status as ConnectionStatus),
    });
  }

  connect(docName: string, doc: Y.Doc): DocSyncHandle {
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: docName,
      document: doc,
      token: this.options.token,
      onAuthenticationFailed: () => this.handleAuthFailed(),
    });
    provider.attach();
    this.providers.add(provider);
    return {
      isSynced: () => provider.isSynced,
      whenSynced: () => waitForSynced(provider),
      destroy: () => {
        this.providers.delete(provider);
        provider.destroy();
      },
    };
  }

  /** Disconnects without forgetting documents; edits keep accumulating locally. */
  pause(): void {
    this.socket.disconnect();
  }

  resume(): void {
    if (this.authFailed) return;
    void this.socket.connect();
  }

  destroy(): void {
    for (const provider of this.providers) provider.destroy();
    this.providers.clear();
    this.socket.destroy();
  }

  /** A rejected token will not start working by retrying; stop until the user fixes the settings. */
  private handleAuthFailed(): void {
    if (this.authFailed) return;
    this.authFailed = true;
    this.socket.disconnect();
    this.options.onAuthFailed();
  }
}

function waitForSynced(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve) => {
    const onSynced = () => {
      if (!provider.isSynced) return;
      provider.off("synced", onSynced);
      resolve();
    };
    provider.on("synced", onSynced);
  });
}
```

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npm run check`
Expected: all tests PASS, typecheck exits 0. If `merges edits made while one device was disconnected` is flaky, confirm `pause()` really stops traffic (log `onStatus`) before touching timeouts.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin
git commit -m "feat(core): sync over Hocuspocus with one shared socket and stop on auth failure"
```

---

## After this plan

Plan 2 (separate document, written after Plan 1 lands) covers: Obsidian adapters for `VaultPort` (`vault.process` for `replace`), `StoragePort` and `DocPersistence` (y-indexeddb), `EditorBinding` with `y-codemirror.next` and remote cursors (the syncer will expose provider awareness), settings tab and token storage, status bar and notices, `visibilitychange` → `resume()`, the spec §9 spikes, README operating guide (§8), and the manual E2E checklist.
