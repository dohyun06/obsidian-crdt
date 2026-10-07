# Obsidian Integration Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the headless sync core from Plan 1 into an installable Obsidian plugin (desktop + mobile): vault/storage adapters, live CM6 editor binding with remote cursors, settings with the token in Obsidian's SecretStorage, status bar, notices, and lifecycle — plus the Plan 1 carry-overs that the plugin depends on.

**Architecture:** `packages/plugin/src/core` stays Obsidian-free and gains three editor-facing engine calls (`openDocForPath`, `captureEditorSnapshot`, `notifyEditorClosed`). New layers sit around it: `obsidian/` adapters implement the core ports against narrow Obsidian-like interfaces (unit-tested with fakes), `editor/` binds CodeMirror 6 to Y.Text with `y-codemirror.next` (unit-tested in jsdom), `session/` composes one running sync session (tested with the loopback fakes), and thin untested glue (`main.ts`, setting tab, modal, status bar) wires Obsidian APIs to those units. Everything that can only be verified inside real Obsidian is collected into a manual verification checklist (spec §9 spikes).

**Tech Stack:** TypeScript 5.9, Obsidian API 1.13.1 types (min app 1.11.4 for `SecretStorage`), CodeMirror 6 (`@codemirror/state` 6.5.0 / `@codemirror/view` 6.38.6 — Obsidian's versions, external at runtime), y-codemirror.next 0.3.6, y-protocols 1.0.7, Yjs 13.6, IndexedDB (fake-indexeddb 6.2.5 in tests), jsdom 30 (editor tests), esbuild 0.28, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md` (Plan 1: `docs/superpowers/plans/2026-10-07-sync-core-and-server.md`)

## Global Constraints

- Follow `AGENTS.md`: file ≤ 300 LOC, function ≤ 50 LOC, ≤ 5 parameters, complexity ≤ 10; side effects at the boundary; catch only specific errors (queue/task boundaries may catch-and-report); never log tokens or note contents.
- `packages/plugin/src/core` must not import `obsidian`, `@codemirror/*` or any Node built-in. `src/editor`, `src/obsidian`, `src/session`, `src/settings` must not import Node built-ins either (the plugin runs on iOS/Android).
- Plugin manifest: id `crdt-sync`, name `CRDT Sync`, `minAppVersion` `1.11.4`, `isDesktopOnly` `false`.
- Bundle: CommonJS `main.js`; `obsidian`, `electron`, `@codemirror/*`, `@lezer/*` and all Node built-ins are external; the only externals the bundle may actually import are `obsidian`, `@codemirror/state`, `@codemirror/view`.
- The server token lives only in `app.secretStorage` (secret id rule: lowercase alphanumeric with dashes); `data.json` stores the secret **id**, never the token.
- Server URL: `wss://` only; `ws://` only for `localhost`, `127.0.0.1`, `[::1]` (existing `assertSecureServerUrl`).
- Sync-applied renames use `vault.rename` (no link rewriting); sync-applied deletes use `vault.trash(file, false)` (vault `.trash`, recoverable).
- Excluded prefixes: `.obsidian/`, `.trash/`, `.git/` plus `<app.vault.configDir>/`; prefix matching is case-insensitive.
- Same-path collision detection is case-insensitive (spec §9 case-insensitive row).
- Editor close order (spec §9, Plan 1 final review): capture Y.Text snapshot → save editor → detach → `notifyEditorClosed` (only when no other pane still shows the file).
- UI strings are Korean and live in `src/session/messages.ts`.

## Review Focus

1. **The same note open in two panes on one device:** closing one pane must keep syncing the other and must not tell the engine the file closed — pinned in Task 7 (`keeps a file open while another pane still shows it`).
2. **A brand-new note typed into immediately** (the engine has not registered it yet when the editor opens): the editor must bind once the engine catches up — pinned in Task 7 (`retries binding until the engine tracks the file`).
3. **Renaming the open note from the file explorer:** the editor keeps the same view and content; binding must move to the new path without pushing content anywhere — pinned in Task 7 (`follows a rename of the open file`).
4. **Changing settings while sync runs** (e.g. new server URL): the old session must be fully torn down before the new one starts — no second engine, no leaked socket — pinned in Task 9 (`restarting stops the old session before starting the new one`).
5. **Disabling the plugin while startup is still opening storage:** no leaked IndexedDB connection or syncer, no unhandled rejection — pinned in Task 9 (`stop during start releases everything`).

---

## File Structure

```
packages/shared/src/path.ts                 # + foldPathCase, case-insensitive exclusions (Task 1)
packages/shared/src/constants.ts            # + EDITOR_SNAPSHOT_DEBOUNCE_MS (Task 2)
packages/plugin/
  manifest.json  styles.css  esbuild.config.mjs  scripts/install-dev.mjs   (Tasks 3, 10)
  src/core/
    vaultIndex.ts docManager.ts localChanges.ts syncEngine.ts   # hardening (Task 1)
    textHistory.ts                          # recent Y.Text states per open file (Task 2)
    engineWiring.ts                         # wire() moved out of syncEngine.ts (Task 2)
    ports.ts fileReconciler.ts hocuspocusSyncer.ts             # awareness, history (Task 2)
  src/obsidian/
    idb.ts idbStorage.ts idbDocPersistence.ts                  # IndexedDB adapters (Task 4)
    vaultAdapter.ts                                            # VaultPort over Obsidian Vault (Task 5)
  src/editor/
    editorSync.ts                           # CM6 ⇄ Y.Text primitives + file-switch guard (Task 6)
    editorBridge.ts                         # per-view binding lifecycle (Task 7)
  src/settings/settings.ts settingTab.ts    # model/validation + UI glue (Task 8)
  src/session/status.ts messages.ts syncSession.ts             # (Tasks 8, 9)
  src/ui/statusBar.ts massDeleteModal.ts                       # glue (Task 9)
  src/main.ts                               # plugin entry (stub Task 3, real Task 9)
  test/... (one test file per unit above), test/fakes/fakeObsidianVault.ts
docs/manual-verification.md  README.md      # (Task 10)
```

---

### Task 1: Core hardening carried over from Plan 1

**Files:**
- Modify: `packages/shared/src/path.ts`, `packages/plugin/src/core/vaultIndex.ts`, `packages/plugin/src/core/docManager.ts`, `packages/plugin/src/core/localChanges.ts`, `packages/plugin/src/core/syncEngine.ts`, `packages/plugin/package.json`
- Test: `packages/shared/test/path.test.ts`, `packages/plugin/test/vaultIndex.test.ts`, `packages/plugin/test/docManager.test.ts`, `packages/plugin/test/syncEngine.test.ts`

**Interfaces:**
- Produces: `foldPathCase(path: string): string` (shared); `isSyncablePath` excludes prefixes case-insensitively; `VaultIndex.planCollisionResolution()` groups by folded path; `DocManager.open` retries after a failed attach and `closeAll` survives failed slots; `SyncEngine.route` matches echoes on normalized paths; `LocalChangeHandler` notifies `file-too-large` once per oversize episode; plugin depends on `y-protocols`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/path.test.ts` (inside the existing `describe("vault paths", …)`):
```ts
  it("excludes configured folders regardless of letter case", () => {
    expect(isSyncablePath(".Obsidian/workspace.md")).toBe(false);
    expect(isSyncablePath(".TRASH/a.md")).toBe(false);
    expect(isSyncablePath("Custom-Config/x.md", ["custom-config/"])).toBe(false);
  });

  it("folds path case for collision checks", () => {
    expect(foldPathCase("Notes/Note.md")).toBe(foldPathCase("notes/note.md"));
  });
```
and add `foldPathCase` to that file's import list.

Append to `packages/plugin/test/vaultIndex.test.ts` (inside `describe("VaultIndex", …)`):
```ts
  it("treats paths that differ only in letter case as a collision", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    new VaultIndex(docA, idsFrom(ID_B)).register("Note.md", CREATED);
    new VaultIndex(docB, idsFrom(ID_A)).register("note.md", CREATED);
    sync(docA, docB);
    expect(new VaultIndex(docB).planCollisionResolution()).toEqual([
      { fileId: ID_B, fromPath: "Note.md", toPath: "Note (conflict 2026-10-07 bbbbbb).md" },
    ]);
  });
```

Append to `packages/plugin/test/docManager.test.ts` (inside `describe("DocManager", …)`):
```ts
  it("retries opening after a persistence failure and still closes other docs", async () => {
    const hub = new LoopbackHub();
    const persistence = new MemoryPersistence();
    let failNext = true;
    const flaky = {
      attach: async (name: string, doc: import("yjs").Doc) => {
        if (failNext) {
          failNext = false;
          throw new Error("storage hiccup");
        }
        return persistence.attach(name, doc);
      },
    };
    const docs = new DocManager({ vaultId: VAULT, syncer: new LoopbackSyncer(hub), persistence: flaky, onTextChanged: () => {} });
    await expect(docs.open(FILE)).rejects.toThrow("storage hiccup");
    const reopened = await docs.open(FILE);
    reopened.text.insert(0, "ok");
    const other = "4f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";
    failNext = true;
    await expect(docs.open(other)).rejects.toThrow("storage hiccup");
    await expect(docs.closeAll()).resolves.toBeUndefined();
    expect(reopened.doc.isDestroyed).toBe(true);
  });
```

Append to `packages/plugin/test/syncEngine.test.ts` (new `describe` at the end of the file):
```ts
import { FakeVault } from "./fakes/fakeVault";
import { createDevice } from "./fakes/device";
import type { VaultEvent } from "../src/core/ports";

/** Reports event paths with a leading "./", as some platforms do; the engine must still recognise its own echoes. */
class PrefixingVault extends FakeVault {
  override onEvent(listener: (event: VaultEvent) => void): () => void {
    return super.onEvent((event) =>
      listener(event.type === "rename" ? { ...event, oldPath: `./${event.oldPath}`, path: `./${event.path}` } : { ...event, path: `./${event.path}` }),
    );
  }
}

describe("SyncEngine — hardening", () => {
  it("recognises its own rename echoes when event paths are not normalized", async () => {
    const hub = new LoopbackHub();
    const a = await startDevice(hub, "A");
    const b = createDevice(hub, "B", { reuse: undefined });
    const vaultB = new PrefixingVault();
    const deviceB = createDevice(hub, "B", { reuse: { ...b, vault: vaultB } });
    await deviceB.engine.start();
    running.push(a, deviceB);
    for (const [path, text] of [["a.md", "one\n"], ["c.md", "three\n"]] as const) a.vault.externalWrite(path, text);
    await settle([a, deviceB]);
    a.vault.externalRename("a.md", "b.md");
    a.vault.externalRename("c.md", "a.md");
    await settle([a, deviceB], 12);
    expect(Object.fromEntries([...vaultB.files.entries()].sort())).toEqual({ "a.md": "three\n", "b.md": "one\n" });
  });

  it("reports an oversize untracked file once until it fits", async () => {
    const { a, b } = await pair();
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    a.vault.externalWrite("big.md", huge);
    await settle([a, b]);
    a.vault.externalWrite("big.md", `${huge}y`);
    await settle([a, b]);
    expect(a.notices.filter((notice) => notice.kind === "file-too-large")).toHaveLength(1);
  });
});
```

> `createDevice(hub, name, { reuse })` reuses `vault`, `storage`, `persistence` and `openInEditor` from the given object (see `test/fakes/device.ts`); building `b` first only supplies storage/persistence for the prefixing vault.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/test/path.test.ts packages/plugin/test/vaultIndex.test.ts packages/plugin/test/docManager.test.ts packages/plugin/test/syncEngine.test.ts`
Expected: FAIL — `foldPathCase` missing; case collision plan empty; second `open` rejects again / `closeAll` rejects; prefixing-vault devices diverge or produce `(conflict` files; oversize notices = 2.

- [ ] **Step 3: Implement**

`packages/shared/src/path.ts` — add `foldPathCase` and use it in `isSyncablePath`:
```ts
/** Case-insensitive file systems (macOS, iOS, Windows) treat these paths as the same file. */
export function foldPathCase(path: string): string {
  return path.toLowerCase();
}

/** Expects a normalized path. */
export function isSyncablePath(path: string, extraExcludedPrefixes: readonly string[] = []): boolean {
  if (!isSafeRelativePath(path)) return false;
  if (!path.toLowerCase().endsWith(SYNCABLE_EXTENSION)) return false;
  const folded = foldPathCase(path);
  const excluded = [...EXCLUDED_PATH_PREFIXES, ...extraExcludedPrefixes];
  return !excluded.some((prefix) => folded.startsWith(foldPathCase(prefix)));
}
```

`packages/plugin/src/core/vaultIndex.ts` — replace the grouping in `planCollisionResolution` (import `foldPathCase` from `@obsidian-crdt/shared`):
```ts
  planCollisionResolution(): PathReassignment[] {
    const byFoldedPath = new Map<string, IndexEntry[]>();
    for (const entry of this.liveEntries()) {
      const key = foldPathCase(entry.path);
      byFoldedPath.set(key, [...(byFoldedPath.get(key) ?? []), entry]);
    }
    const plan: PathReassignment[] = [];
    for (const group of byFoldedPath.values()) {
      for (const loser of group.slice(1)) {
        const toPath = buildConflictPath({ path: loser.path, label: "conflict", timestampMs: loser.createdAt, fileId: loser.fileId });
        plan.push({ fileId: loser.fileId, fromPath: loser.path, toPath });
      }
    }
    return plan;
  }
```

`packages/plugin/src/core/docManager.ts` — replace `open` and `closeAll`:
```ts
  async open(fileId: string): Promise<OpenedDoc> {
    let slot = this.slots.get(fileId);
    if (!slot) {
      const created = this.createSlot(fileId);
      slot = created;
      this.slots.set(fileId, created);
      // A failed attach (e.g. a storage hiccup) must not poison this file for the rest of the session.
      created.catch(() => {
        if (this.slots.get(fileId) === created) this.slots.delete(fileId);
      });
    }
    return (await slot).opened;
  }

  async closeAll(): Promise<void> {
    const settled = await Promise.allSettled(this.slots.values());
    this.slots.clear();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const { opened, persisted } = result.value;
      opened.sync.destroy();
      persisted.destroy();
      opened.doc.destroy();
    }
  }
```

`packages/plugin/src/core/syncEngine.ts` — normalize before consuming echoes. Replace the first two lines of `route` and the rename case:
```ts
  private route(event: VaultEvent): void {
    if (this.stopped) return;
    const normalized = normalizeEvent(event);
    if (this.requireWiring().echoes.consume(normalized)) return;
    const path = normalized.path;
    switch (normalized.type) {
```
```ts
      case "rename":
        // A move into an excluded folder becomes a pending delete, so the commit must be scheduled here too.
        void this.enqueue(({ local }) => local.handleRename(normalized.oldPath, path));
        this.scheduleDeleteCommit();
        return;
```
and add at the bottom of the file:
```ts
function normalizeEvent(event: VaultEvent): VaultEvent {
  if (event.type === "rename") return { ...event, oldPath: normalizeVaultPath(event.oldPath), path: normalizeVaultPath(event.path) };
  return { ...event, path: normalizeVaultPath(event.path) };
}
```

`packages/plugin/src/core/localChanges.ts` — add a field and use it in `handleCreate`:
```ts
  private readonly oversizeNotified = new Set<string>();
```
```ts
    if (!isWithinSizeLimit(text)) {
      if (!this.oversizeNotified.has(path)) {
        this.oversizeNotified.add(path);
        this.deps.notify({ kind: "file-too-large", path });
      }
      return;
    }
    this.oversizeNotified.delete(path);
```

`packages/plugin/package.json` — add `"y-protocols": "^1.0.7"` to `dependencies` (peer of `@hocuspocus/provider`, needed for `Awareness` in Task 2), then run `npm install`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run check`
Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/plugin package-lock.json
git commit -m "fix(core): case-insensitive collisions, resilient doc slots, normalized echoes"
```

---

### Task 2: Engine support for the editor binding

**Files:**
- Create: `packages/plugin/src/core/textHistory.ts`, `packages/plugin/src/core/engineWiring.ts`
- Modify: `packages/shared/src/constants.ts`, `packages/plugin/src/core/ports.ts`, `packages/plugin/src/core/docManager.ts`, `packages/plugin/src/core/fileReconciler.ts`, `packages/plugin/src/core/syncEngine.ts`, `packages/plugin/src/core/hocuspocusSyncer.ts`, `packages/plugin/test/fakes/loopback.ts`, `packages/plugin/test/fakes/device.ts`
- Test: `packages/plugin/test/textHistory.test.ts`, `packages/plugin/test/editorSupport.test.ts`

**Interfaces:**
- Consumes: Plan 1 engine; `Awareness` from `y-protocols/awareness`.
- Produces:
  - `EDITOR_SNAPSHOT_DEBOUNCE_MS = 200` (shared constant); `SyncTiming.editorSnapshotDebounceMs`
  - `DocSyncHandle.awareness: Awareness | null` (Loopback → `null`, Hocuspocus → `provider.awareness`)
  - `DocManager.peek(fileId: string): OpenedDoc | undefined`
  - `class TextHistory { record(fileId, text): void; has(fileId, text): boolean; forget(fileId): void }`, `TEXT_HISTORY_LIMIT = 32`
  - `interface EditorDoc { fileId: string; text: Y.Text; awareness: Awareness | null }`
  - `SyncEngine.openDocForPath(path: string): Promise<EditorDoc | null>`; `SyncEngine.captureEditorSnapshot(path: string): void`; existing `notifyEditorClosed(path)`
  - `createWiring(deps: SyncEngineDeps, hooks: WiringHooks): Promise<Wiring>` in `engineWiring.ts`

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/textHistory.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TEXT_HISTORY_LIMIT, TextHistory } from "../src/core/textHistory";

describe("TextHistory", () => {
  it("remembers recent texts per file", () => {
    const history = new TextHistory();
    history.record("f1", "a");
    history.record("f1", "ab");
    expect(history.has("f1", "a")).toBe(true);
    expect(history.has("f2", "a")).toBe(false);
  });

  it("skips consecutive duplicates and keeps only the most recent entries", () => {
    const history = new TextHistory();
    for (let i = 0; i <= TEXT_HISTORY_LIMIT; i++) history.record("f1", `v${i}`);
    history.record("f1", `v${TEXT_HISTORY_LIMIT}`);
    expect(history.has("f1", "v0")).toBe(false);
    expect(history.has("f1", `v${TEXT_HISTORY_LIMIT}`)).toBe(true);
  });

  it("forgets a file", () => {
    const history = new TextHistory();
    history.record("f1", "a");
    history.forget("f1");
    expect(history.has("f1", "a")).toBe(false);
  });
});
```

`packages/plugin/test/editorSupport.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { LoopbackHub } from "./fakes/loopback";
import { type Device, FAST_TIMING, settle, startDevice } from "./fakes/device";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function pair() {
  const hub = new LoopbackHub();
  const a = await startDevice(hub, "A");
  const b = await startDevice(hub, "B");
  running.push(a, b);
  return { hub, a, b };
}

describe("engine support for editors", () => {
  it("opens the shared Y.Text for a tracked path and returns null otherwise", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "hello");
    await settle([a, b]);
    const doc = await a.engine.openDocForPath("n.md");
    expect(doc?.text.toString()).toBe("hello");
    expect(doc?.awareness).toBeNull();
    expect(await a.engine.openDocForPath("missing.md")).toBeNull();
    expect(await a.engine.openDocForPath(".obsidian/x.md")).toBeNull();
  });

  it("does not duplicate text when the close-time save lags behind a remote edit (explicit snapshot)", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "l1\nl2\n");
    await settle([a, b]);
    a.openInEditor.add("n.md");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    doc.text.insert(0, "typed ");
    a.engine.captureEditorSnapshot("n.md");
    const saved = doc.text.toString();
    await settle([a, b]);
    b.vault.externalWrite("n.md", `${b.vault.files.get("n.md")}B\n`);
    await settle([b]);
    a.vault.externalWrite("n.md", saved); // the editor's save of the captured state lands after the remote edit
    await settle([a]);
    a.openInEditor.delete("n.md");
    a.engine.notifyEditorClosed("n.md");
    await settle([a, b]);
    b.vault.externalWrite("n.md", `${b.vault.files.get("n.md")}C\n`);
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("typed l1\nl2\nB\nC\n");
    expect(b.vault.files.get("n.md")).toBe("typed l1\nl2\nB\nC\n");
  });

  it("does not duplicate text when an autosave lags behind a remote edit (debounced snapshot)", async () => {
    const { a, b } = await pair();
    a.vault.externalWrite("n.md", "l1\nl2\n");
    await settle([a, b]);
    a.openInEditor.add("n.md");
    const doc = (await a.engine.openDocForPath("n.md"))!;
    doc.text.insert(0, "typed ");
    const saved = doc.text.toString();
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.editorSnapshotDebounceMs * 5));
    await settle([a, b]);
    b.vault.externalWrite("n.md", `${b.vault.files.get("n.md")}B\n`);
    await settle([b]);
    a.vault.externalWrite("n.md", saved);
    await settle([a]);
    a.openInEditor.delete("n.md");
    a.engine.notifyEditorClosed("n.md");
    await settle([a, b]);
    expect(a.vault.files.get("n.md")).toBe("typed l1\nl2\nB\n");
    expect(b.vault.files.get("n.md")).toBe("typed l1\nl2\nB\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/textHistory.test.ts packages/plugin/test/editorSupport.test.ts`
Expected: FAIL — `textHistory` module missing; `openDocForPath`/`captureEditorSnapshot` not functions; the lag tests (once the methods exist) show `"typed typed l1…"`.

- [ ] **Step 3: Implement the history and handle/awareness changes**

`packages/shared/src/constants.ts` — add:
```ts
/** Idle time after which the Y.Text of a file open in an editor is remembered as a possible autosave state. */
export const EDITOR_SNAPSHOT_DEBOUNCE_MS = 200;
```

`packages/plugin/src/core/textHistory.ts`:
```ts
export const TEXT_HISTORY_LIMIT = 32;

/**
 * Recent Y.Text states of files shown in an editor. The editor's autosave writes one of these states to disk,
 * possibly after newer remote edits arrived; a disk text found here carries nothing new (spec §9 fallback).
 */
export class TextHistory {
  private readonly byFile = new Map<string, string[]>();

  record(fileId: string, text: string): void {
    const list = this.byFile.get(fileId) ?? [];
    if (list[list.length - 1] === text) return;
    list.push(text);
    if (list.length > TEXT_HISTORY_LIMIT) list.shift();
    this.byFile.set(fileId, list);
  }

  has(fileId: string, text: string): boolean {
    return this.byFile.get(fileId)?.includes(text) ?? false;
  }

  forget(fileId: string): void {
    this.byFile.delete(fileId);
  }
}
```

`packages/plugin/src/core/ports.ts` — extend the handle (add `import type { Awareness } from "y-protocols/awareness";`):
```ts
export interface DocSyncHandle {
  isSynced(): boolean;
  whenSynced(): Promise<void>;
  destroy(): void;
  /** Presence channel for remote cursors; null when the transport has none. */
  readonly awareness: Awareness | null;
}
```

`packages/plugin/test/fakes/loopback.ts` — in `LoopbackSyncer.connect`, add `awareness: null,` to the returned handle object.

`packages/plugin/src/core/hocuspocusSyncer.ts` — in `connect`, add `awareness: provider.awareness ?? null,` to the returned handle object.

`packages/plugin/src/core/docManager.ts` — keep a map of resolved docs:
```ts
  private readonly ready = new Map<string, OpenedDoc>();

  /** The doc if it has finished opening; never starts an open. */
  peek(fileId: string): OpenedDoc | undefined {
    return this.ready.get(fileId);
  }
```
At the end of `createSlot`, before `return`, build the `OpenedDoc`, store it with `this.ready.set(fileId, opened)`, and return `{ opened, persisted }`. In `closeAll`, call `this.ready.clear()` after `this.slots.clear()`.

`packages/plugin/src/core/fileReconciler.ts` — add `history: TextHistory` to `FileReconcilerDeps` (import from `./textHistory`). In `reconcile`, replace the decision lines with:
```ts
    const current = opened.text.toString();
    // A disk text the Y.Text already had (a lagging editor save) carries nothing new: it is the real base.
    const base = record.base !== null && disk !== current && this.deps.history.has(fileId, disk) ? disk : record.base;
    const decision = decideDiskReconcile({ base, disk, current });
    const settled = await this.apply({ fileId, path: record.path, opened, disk }, decision);
    if (!settled) return this.deps.requestRetry(fileId);
    this.deps.history.forget(fileId);
```
In `acceptEditorSave`, replace the guard line with:
```ts
    if (disk === null || disk === record.base) return;
    if (disk !== opened.text.toString() && !this.deps.history.has(fileId, disk)) return;
```
and update its doc comment's last sentence to: "A save of a state the Y.Text recently had (recorded in TextHistory) is accepted too; anything else is ignored."

- [ ] **Step 4: Move wiring out of the engine and add the editor calls**

`packages/plugin/src/core/engineWiring.ts`:
```ts
import * as Y from "yjs";
import { buildIndexDocName, isSyncablePath } from "@obsidian-crdt/shared";
import { DocManager } from "./docManager";
import { EchoTrackingVault } from "./echoTrackingVault";
import { FileReconciler } from "./fileReconciler";
import { IndexApplier } from "./indexApplier";
import { LocalChangeHandler } from "./localChanges";
import { MassDeleteGuard } from "./massDeleteGuard";
import type { SyncNotice } from "./notices";
import type { DocPersistence, DocSyncer, DocSyncHandle, PersistedDoc, StoragePort, VaultPort } from "./ports";
import { RecordStore } from "./recordStore";
import { StartupScan } from "./startupScan";
import { TextHistory } from "./textHistory";
import { VaultIndex } from "./vaultIndex";

export interface Wiring {
  records: RecordStore;
  docs: DocManager;
  index: VaultIndex;
  indexSync: DocSyncHandle;
  indexPersisted: PersistedDoc;
  indexDoc: Y.Doc;
  reconciler: FileReconciler;
  local: LocalChangeHandler;
  applier: IndexApplier;
  echoes: EchoTrackingVault;
  scan: StartupScan;
  history: TextHistory;
}

export interface WiringInputs {
  vaultId: string;
  vault: VaultPort;
  storage: StoragePort;
  syncer: DocSyncer;
  persistence: DocPersistence;
  excludedPrefixes?: readonly string[];
}

export interface WiringHooks {
  now: () => number;
  notify: (notice: SyncNotice) => void;
  isOpenInEditor: (path: string) => boolean;
  massDelete: { threshold: number; windowMs: number };
  onTextChanged: (fileId: string) => void;
  requestRetry: (fileId: string) => void;
  requestPass: () => void;
}

export async function createWiring(inputs: WiringInputs, hooks: WiringHooks): Promise<Wiring> {
  const { vaultId, storage, syncer, persistence } = inputs;
  const echoes = new EchoTrackingVault(inputs.vault);
  const vault = echoes;
  const records = await RecordStore.load(storage);
  const docs = new DocManager({ vaultId, syncer, persistence, onTextChanged: hooks.onTextChanged });
  const indexDoc = new Y.Doc();
  const indexName = buildIndexDocName(vaultId);
  const indexPersisted = await persistence.attach(indexName, indexDoc);
  const indexSync = syncer.connect(indexName, indexDoc);
  const index = new VaultIndex(indexDoc);
  const history = new TextHistory();
  const isEligible = (path: string) => isSyncablePath(path, inputs.excludedPrefixes);
  const { now, notify, isOpenInEditor } = hooks;
  const reconciler = new FileReconciler({ vault, records, docs, now, notify, history, requestRetry: hooks.requestRetry });
  const guard = new MassDeleteGuard({ ...hooks.massDelete, now });
  const local = new LocalChangeHandler({ vault, index, records, docs, reconciler, guard, now, notify, isEligible, isOpenInEditor });
  const applier = new IndexApplier({ vault, index, records, docs, reconciler, isEligible, requestPass: hooks.requestPass });
  const scan = new StartupScan({ vault, records, reconciler, local, applier, isEligible, notify });
  return { records, docs, index, indexSync, indexPersisted, indexDoc, reconciler, local, applier, echoes, scan, history };
}
```

`packages/plugin/src/core/syncEngine.ts`:
- Remove the `Wiring` interface and imports that only `wire()` used; `import { createWiring, type Wiring } from "./engineWiring";`, `import type { Awareness } from "y-protocols/awareness";`, `import type * as Y from "yjs";`, and `EDITOR_SNAPSHOT_DEBOUNCE_MS` from shared.
- Add `editorSnapshotDebounceMs: number;` to `SyncTiming` and `editorSnapshotDebounceMs: EDITOR_SNAPSHOT_DEBOUNCE_MS,` to `DEFAULT_TIMING`.
- Export the editor doc type:
```ts
export interface EditorDoc {
  fileId: string;
  text: Y.Text;
  awareness: Awareness | null;
}
```
- Replace `wire()` with:
```ts
  private async wire(): Promise<Wiring> {
    this.wiring = await createWiring(this.deps, {
      now: this.now,
      notify: this.notify,
      isOpenInEditor: this.isOpenInEditor,
      massDelete: { threshold: this.timing.massDeleteThreshold, windowMs: this.timing.massDeleteWindowMs },
      onTextChanged: (id) => this.onTextChanged(id),
      requestRetry: (id) => this.scheduleTextFlush(id),
      requestPass: () => this.scheduleIndexPass(),
    });
    return this.wiring;
  }
```
- Add the editor-facing methods and helpers:
```ts
  /** The shared Y.Text for a tracked file, after every earlier vault event has been handled. */
  async openDocForPath(path: string): Promise<EditorDoc | null> {
    const normalized = normalizeVaultPath(path);
    let result = null as EditorDoc | null;
    await this.enqueue(async ({ records, docs }) => {
      const fileId = records.findIdByPath(normalized);
      if (!fileId) return;
      const opened = await docs.open(fileId);
      result = { fileId, text: opened.text, awareness: opened.sync.awareness };
    });
    return result;
  }

  /** Remember the current Y.Text of an open file right before the editor saves it (spec §9 close order). */
  captureEditorSnapshot(path: string): void {
    const fileId = this.wiring?.records.findIdByPath(normalizeVaultPath(path));
    if (fileId) this.captureSnapshot(fileId);
  }

  private onTextChanged(fileId: string): void {
    this.scheduleTextFlush(fileId);
    const record = this.wiring?.records.get(fileId);
    if (!record || this.stopped || !this.isOpenInEditor(record.path)) return;
    this.debouncer.schedule(`snap:${fileId}`, this.timing.editorSnapshotDebounceMs, () => this.captureSnapshot(fileId));
  }

  private captureSnapshot(fileId: string): void {
    const wiring = this.wiring;
    const opened = wiring?.docs.peek(fileId);
    if (wiring && opened) wiring.history.record(fileId, opened.text.toString());
  }
```

`packages/plugin/test/fakes/device.ts` — add `editorSnapshotDebounceMs: 2,` to `FAST_TIMING`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: all tests PASS (including every Plan 1 test), typecheck exits 0, `wc -l packages/plugin/src/core/syncEngine.ts` ≤ 300.

- [ ] **Step 6: Commit**

```bash
git add packages/shared packages/plugin
git commit -m "feat(core): editor doc access, awareness and lag-proof editor saves"
```

---

### Task 3: Plugin build, manifest and bundle guard

**Files:**
- Create: `packages/plugin/manifest.json`, `packages/plugin/versions.json`, `packages/plugin/styles.css`, `packages/plugin/esbuild.config.mjs`, `packages/plugin/src/main.ts` (stub)
- Modify: `packages/plugin/package.json`, `.gitignore` (already ignores `dist/`)
- Test: `packages/plugin/test/bundle.test.ts`

**Interfaces:**
- Produces: `npm run build -w @obsidian-crdt/plugin` → `packages/plugin/dist/{main.js,manifest.json,styles.css}`; with `BUNDLE_META=1` also `dist/meta.json` (esbuild metafile). `src/main.ts` default-exports a `Plugin` subclass (replaced in Task 9).

- [ ] **Step 1: Add dependencies and package scripts**

Replace `packages/plugin/package.json` with:
```json
{
  "name": "@obsidian-crdt/plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "install-dev": "node scripts/install-dev.mjs"
  },
  "dependencies": {
    "@hocuspocus/provider": "^4.7.0",
    "@obsidian-crdt/shared": "*",
    "diff-match-patch": "^1.0.5",
    "y-codemirror.next": "^0.3.6",
    "y-protocols": "^1.0.7",
    "yjs": "^13.6.33"
  },
  "devDependencies": {
    "@codemirror/state": "6.5.0",
    "@codemirror/view": "6.38.6",
    "@obsidian-crdt/server": "*",
    "@types/diff-match-patch": "^1.0.36",
    "esbuild": "^0.28.2",
    "fake-indexeddb": "^6.2.5",
    "jsdom": "^30.1.2",
    "obsidian": "1.13.1"
  }
}
```
Run: `npm install` then `npm ls @codemirror/state yjs`
Expected: exactly one `@codemirror/state@6.5.0` and one `yjs` (deduped).

- [ ] **Step 2: Write the failing test**

`packages/plugin/test/bundle.test.ts`:
```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/plugin/test/bundle.test.ts`
Expected: FAIL — `esbuild.config.mjs` not found.

- [ ] **Step 4: Implement build files**

`packages/plugin/manifest.json`:
```json
{
  "id": "crdt-sync",
  "name": "CRDT Sync",
  "version": "0.1.0",
  "minAppVersion": "1.11.4",
  "description": "Conflict-free real-time sync of Markdown notes across your devices (Yjs + Hocuspocus).",
  "author": "Dohyun Kim",
  "isDesktopOnly": false
}
```

`packages/plugin/versions.json`:
```json
{
  "0.1.0": "1.11.4"
}
```

`packages/plugin/styles.css`:
```css
.crdt-sync-status {
  font-variant-numeric: tabular-nums;
}

.crdt-sync-modal-list {
  max-height: 40vh;
  overflow-y: auto;
  font-family: var(--font-monospace);
  font-size: var(--font-ui-smaller);
}
```

`packages/plugin/esbuild.config.mjs`:
```js
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
```

`packages/plugin/src/main.ts` (stub, replaced in Task 9):
```ts
import { Plugin } from "obsidian";

export default class CrdtSyncPlugin extends Plugin {
  async onload(): Promise<void> {}
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/bundle.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin package-lock.json
git commit -m "build(plugin): add manifest, esbuild bundle and bundle guard test"
```

---

### Task 4: IndexedDB storage and document persistence

**Files:**
- Create: `packages/plugin/src/obsidian/idb.ts`, `packages/plugin/src/obsidian/idbStorage.ts`, `packages/plugin/src/obsidian/idbDocPersistence.ts`
- Test: `packages/plugin/test/idbStorage.test.ts`, `packages/plugin/test/idbDocPersistence.test.ts`

**Interfaces:**
- Consumes: `StoragePort`, `FileRecord`, `DocPersistence`, `PersistedDoc` (core ports).
- Produces:
  - `openSyncDatabase(name: string, factory: IDBFactory): Promise<IDBDatabase>`; `runRequest<T>(db, store, mode, makeRequest): Promise<T>`; `STORE_RECORDS`, `STORE_FLAGS`, `STORE_DOCS`; `class StorageUnavailableError extends Error`
  - `class IdbStorage implements StoragePort { constructor(db: IDBDatabase) }`
  - `class IdbDocPersistence implements DocPersistence { constructor(db, options?: { saveDebounceMs?: number; onError?: (error: unknown) => void }); flushAll(): Promise<void> }`, `DOC_SAVE_DEBOUNCE_MS = 300`

Design note (deviation from spec §3.2, recorded here): the spec names `y-indexeddb`, which creates **one IndexedDB database per document**; with thousands of notes that is thousands of databases on mobile. One database per vault with a `docs` store keeps the footprint bounded. A ≤ 300 ms save debounce can lose the last keystrokes if the app is killed, but the editor's disk save and the startup three-way scan recover them.

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/idbStorage.test.ts`:
```ts
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { openSyncDatabase, runRequest, STORE_RECORDS } from "../src/obsidian/idb";
import { IdbStorage } from "../src/obsidian/idbStorage";

const DB = "crdt-sync/test-vault/test-vault-01";

describe("IdbStorage", () => {
  it("saves, reloads and deletes records across connections", async () => {
    const factory = new IDBFactory();
    const first = await openSyncDatabase(DB, factory);
    const storage = new IdbStorage(first);
    await storage.saveRecord("id-1", { path: "a.md", base: "x" });
    await storage.saveRecord("id-2", { path: "b.md", base: null });
    await storage.deleteRecord("id-2");
    first.close();
    const second = await openSyncDatabase(DB, factory);
    expect(await new IdbStorage(second).loadRecords()).toEqual([["id-1", { path: "a.md", base: "x" }]]);
    second.close();
  });

  it("stores flags", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const storage = new IdbStorage(db);
    expect(await storage.getFlag("bootstrapped")).toBe(false);
    await storage.setFlag("bootstrapped", true);
    expect(await storage.getFlag("bootstrapped")).toBe(true);
    db.close();
  });

  it("skips malformed records instead of failing the load", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    await runRequest(db, STORE_RECORDS, "readwrite", (store) => store.put({ fileId: "bad", path: 42, base: null }, "bad"));
    await new IdbStorage(db).saveRecord("good", { path: "g.md", base: "g" });
    expect(await new IdbStorage(db).loadRecords()).toEqual([["good", { path: "g.md", base: "g" }]]);
    db.close();
  });
});
```

`packages/plugin/test/idbDocPersistence.test.ts`:
```ts
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { openSyncDatabase, runRequest, STORE_DOCS } from "../src/obsidian/idb";
import { IdbDocPersistence } from "../src/obsidian/idbDocPersistence";

const DB = "crdt-sync/test-vault/test-vault-01";
const NAME = "test-vault-01/3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b";

describe("IdbDocPersistence", () => {
  it("restores a document after destroy and reopen", async () => {
    const factory = new IDBFactory();
    const db = await openSyncDatabase(DB, factory);
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5 });
    const doc = new Y.Doc();
    const attached = await persistence.attach(NAME, doc);
    doc.getText("content").insert(0, "offline edit");
    attached.destroy();
    await persistence.flushAll();
    db.close();

    const reopened = await openSyncDatabase(DB, factory);
    const restored = new Y.Doc();
    await new IdbDocPersistence(reopened).attach(NAME, restored);
    expect(restored.getText("content").toString()).toBe("offline edit");
    reopened.close();
  });

  it("coalesces rapid updates into one write", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 50 });
    const doc = new Y.Doc();
    await persistence.attach(NAME, doc);
    for (const ch of "abc") doc.getText("content").insert(0, ch);
    expect(await runRequest(db, STORE_DOCS, "readonly", (store) => store.get(NAME))).toBeUndefined();
    await persistence.flushAll();
    const saved = new Y.Doc();
    Y.applyUpdate(saved, (await runRequest(db, STORE_DOCS, "readonly", (store) => store.get(NAME))) as Uint8Array);
    expect(saved.getText("content").toString()).toBe("cba");
    db.close();
  });

  it("does not write back the state it just loaded", async () => {
    const db = await openSyncDatabase(DB, new IDBFactory());
    const seed = new Y.Doc();
    seed.getText("content").insert(0, "seed");
    await runRequest(db, STORE_DOCS, "readwrite", (store) => store.put(Y.encodeStateAsUpdate(seed), NAME));
    const persistence = new IdbDocPersistence(db, { saveDebounceMs: 5 });
    await persistence.attach(NAME, new Y.Doc());
    await persistence.flushAll();
    expect(persistence.pendingWrites).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/idbStorage.test.ts packages/plugin/test/idbDocPersistence.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/plugin/src/obsidian/idb.ts`:
```ts
export const DB_VERSION = 1;
export const STORE_RECORDS = "records";
export const STORE_FLAGS = "flags";
export const STORE_DOCS = "docs";
const STORES = [STORE_RECORDS, STORE_FLAGS, STORE_DOCS] as const;

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/** One database per local vault + sync vault id (spec §3.2 deviation: not one database per document). */
export function openSyncDatabase(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StorageUnavailableError(`cannot open IndexedDB "${name}": ${request.error?.message ?? "unknown error"}`));
    request.onblocked = () => reject(new StorageUnavailableError(`IndexedDB "${name}" is blocked by another connection`));
  });
}

export function runRequest<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  makeRequest: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = makeRequest(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new StorageUnavailableError(`IndexedDB ${mode} on "${store}" failed`));
    transaction.onabort = () => reject(transaction.error ?? new StorageUnavailableError(`IndexedDB ${mode} on "${store}" aborted`));
  });
}
```

`packages/plugin/src/obsidian/idbStorage.ts`:
```ts
import type { FileRecord, StoragePort } from "../core/ports";
import { runRequest, STORE_FLAGS, STORE_RECORDS } from "./idb";

interface StoredRecord {
  fileId: string;
  path: string;
  base: string | null;
}

function toEntry(value: unknown): [string, FileRecord] | null {
  if (typeof value !== "object" || value === null) return null;
  const { fileId, path, base } = value as Record<string, unknown>;
  if (typeof fileId !== "string" || typeof path !== "string") return null;
  if (base !== null && typeof base !== "string") return null;
  return [fileId, { path, base }];
}

export class IdbStorage implements StoragePort {
  constructor(private readonly db: IDBDatabase) {}

  async loadRecords(): Promise<Array<[string, FileRecord]>> {
    const values = await runRequest<unknown[]>(this.db, STORE_RECORDS, "readonly", (store) => store.getAll());
    return values.map(toEntry).filter((entry): entry is [string, FileRecord] => entry !== null);
  }

  async saveRecord(fileId: string, record: FileRecord): Promise<void> {
    const stored: StoredRecord = { fileId, path: record.path, base: record.base };
    await runRequest(this.db, STORE_RECORDS, "readwrite", (store) => store.put(stored, fileId));
  }

  async deleteRecord(fileId: string): Promise<void> {
    await runRequest(this.db, STORE_RECORDS, "readwrite", (store) => store.delete(fileId));
  }

  async getFlag(key: string): Promise<boolean> {
    return (await runRequest<unknown>(this.db, STORE_FLAGS, "readonly", (store) => store.get(key))) === true;
  }

  async setFlag(key: string, value: boolean): Promise<void> {
    await runRequest(this.db, STORE_FLAGS, "readwrite", (store) => store.put(value, key));
  }
}
```

`packages/plugin/src/obsidian/idbDocPersistence.ts`:
```ts
import * as Y from "yjs";
import type { DocPersistence, PersistedDoc } from "../core/ports";
import { runRequest, STORE_DOCS } from "./idb";

export const DOC_SAVE_DEBOUNCE_MS = 300;

export interface IdbDocPersistenceOptions {
  saveDebounceMs?: number;
  onError?: (error: unknown) => void;
}

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  doc: Y.Doc;
}

export class IdbDocPersistence implements DocPersistence {
  private readonly pending = new Map<string, PendingSave>();
  private readonly writes = new Set<Promise<void>>();

  constructor(
    private readonly db: IDBDatabase,
    private readonly options: IdbDocPersistenceOptions = {},
  ) {}

  get pendingWrites(): number {
    return this.pending.size + this.writes.size;
  }

  async attach(docName: string, doc: Y.Doc): Promise<PersistedDoc> {
    const state = await runRequest<unknown>(this.db, STORE_DOCS, "readonly", (store) => store.get(docName));
    if (state instanceof Uint8Array) Y.applyUpdate(doc, state, this);
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== this) this.schedule(docName, doc);
    };
    doc.on("update", onUpdate);
    return {
      destroy: () => {
        doc.off("update", onUpdate);
        this.flush(docName);
      },
    };
  }

  /** Writes every pending save now and waits for all writes; call before closing the database. */
  async flushAll(): Promise<void> {
    for (const docName of [...this.pending.keys()]) this.flush(docName);
    await Promise.allSettled([...this.writes]);
  }

  private schedule(docName: string, doc: Y.Doc): void {
    const existing = this.pending.get(docName);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.flush(docName), this.options.saveDebounceMs ?? DOC_SAVE_DEBOUNCE_MS);
    this.pending.set(docName, { timer, doc });
  }

  private flush(docName: string): void {
    const entry = this.pending.get(docName);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(docName);
    const state = Y.encodeStateAsUpdate(entry.doc); // encode now: the doc may be destroyed right after
    const write = runRequest(this.db, STORE_DOCS, "readwrite", (store) => store.put(state, docName))
      .then(() => undefined)
      .catch((error: unknown) => this.options.onError?.(error));
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/idbStorage.test.ts packages/plugin/test/idbDocPersistence.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin
git commit -m "feat(plugin): persist records and Y.Doc state in one IndexedDB per vault"
```

---

### Task 5: Vault adapter over the Obsidian Vault API

**Files:**
- Create: `packages/plugin/src/obsidian/vaultAdapter.ts`, `packages/plugin/test/fakes/fakeObsidianVault.ts`
- Test: `packages/plugin/test/vaultAdapter.test.ts`

**Interfaces:**
- Consumes: `VaultPort`, `VaultEvent` (core ports).
- Produces:
  - `interface ObsidianFileLike { path: string; extension?: string; children?: unknown }`
  - `interface ObsidianVaultLike` (subset of Obsidian `Vault`: `getMarkdownFiles`, `getAbstractFileByPath`, `read`, `create`, `process`, `rename`, `trash`, `createFolder`, `on`, `offref`)
  - `class ObsidianVaultAdapter implements VaultPort { constructor(vault: ObsidianVaultLike) }`, `class FileNotFoundError extends Error`
  - Fake: `class FakeObsidianVault implements ObsidianVaultLike { seed(path, data): void; files: Map<string, {path; data}>; folders: Set<string>; trashed: Array<{ path: string; system: boolean }> }`

- [ ] **Step 1: Write the fake**

`packages/plugin/test/fakes/fakeObsidianVault.ts`:
```ts
import type { ObsidianFileLike, ObsidianVaultLike, VaultEventRef } from "../../src/obsidian/vaultAdapter";

class FakeFile implements ObsidianFileLike {
  constructor(
    public path: string,
    public data: string,
  ) {}
  get extension(): string {
    return this.path.split(".").pop() ?? "";
  }
}

class FakeFolder implements ObsidianFileLike {
  readonly children: unknown[] = [];
  constructor(public path: string) {}
}

type Handler = (file: ObsidianFileLike, oldPath?: string) => unknown;

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** Behaves like Obsidian's Vault where the adapter depends on it: async events, strict create/createFolder. */
export class FakeObsidianVault implements ObsidianVaultLike {
  readonly files = new Map<string, FakeFile>();
  readonly folders = new Set<string>();
  readonly trashed: Array<{ path: string; system: boolean }> = [];
  private readonly handlers = new Map<string, Set<Handler>>();

  seed(path: string, data: string): void {
    for (let parent = parentOf(path); parent; parent = parentOf(parent)) this.folders.add(parent);
    this.files.set(path, new FakeFile(path, data));
  }

  getMarkdownFiles(): ObsidianFileLike[] {
    return [...this.files.values()].filter((file) => file.extension === "md");
  }

  getAbstractFileByPath(path: string): ObsidianFileLike | null {
    return this.files.get(path) ?? (this.folders.has(path) ? new FakeFolder(path) : null);
  }

  async read(file: ObsidianFileLike): Promise<string> {
    return (file as FakeFile).data;
  }

  async create(path: string, data: string): Promise<ObsidianFileLike> {
    if (this.getAbstractFileByPath(path)) throw new Error("File already exists.");
    if (parentOf(path) && !this.folders.has(parentOf(path))) throw new Error("Parent folder does not exist.");
    const file = new FakeFile(path, data);
    this.files.set(path, file);
    this.emit("create", file);
    return file;
  }

  async process(file: ObsidianFileLike, fn: (data: string) => string): Promise<string> {
    const target = file as FakeFile;
    const next = fn(target.data);
    if (next !== target.data) {
      target.data = next;
      this.emit("modify", target);
    }
    return next;
  }

  async rename(file: ObsidianFileLike, newPath: string): Promise<void> {
    if (this.getAbstractFileByPath(newPath)) throw new Error("Destination file already exists!");
    const oldPath = file.path;
    if (this.folders.has(oldPath)) return this.renameFolder(oldPath, newPath);
    const target = this.files.get(oldPath)!;
    this.files.delete(oldPath);
    target.path = newPath;
    this.files.set(newPath, target);
    this.emit("rename", target, oldPath);
  }

  async trash(file: ObsidianFileLike, system: boolean): Promise<void> {
    this.files.delete(file.path);
    this.trashed.push({ path: file.path, system });
    this.emit("delete", file);
  }

  async createFolder(path: string): Promise<ObsidianFileLike> {
    if (this.getAbstractFileByPath(path)) throw new Error("Folder already exists.");
    if (parentOf(path) && !this.folders.has(parentOf(path))) throw new Error("Parent folder does not exist.");
    this.folders.add(path);
    const folder = new FakeFolder(path);
    this.emit("create", folder);
    return folder;
  }

  on(name: string, callback: Handler): VaultEventRef {
    const set = this.handlers.get(name) ?? new Set<Handler>();
    set.add(callback);
    this.handlers.set(name, set);
    return { name, callback } as VaultEventRef;
  }

  offref(ref: VaultEventRef): void {
    const { name, callback } = ref as unknown as { name: string; callback: Handler };
    this.handlers.get(name)?.delete(callback);
  }

  /** A user edit made in Obsidian outside the plugin. */
  userModify(path: string, data: string): void {
    const file = this.files.get(path)!;
    file.data = data;
    this.emit("modify", file);
  }

  private renameFolder(oldPath: string, newPath: string): void {
    this.folders.delete(oldPath);
    this.folders.add(newPath);
    for (const file of [...this.files.values()].filter((entry) => entry.path.startsWith(`${oldPath}/`))) {
      this.files.delete(file.path);
      file.path = `${newPath}${file.path.slice(oldPath.length)}`;
      this.files.set(file.path, file);
    }
    this.emit("rename", new FakeFolder(newPath), oldPath); // only the folder event, like the worst case
  }

  private emit(name: string, file: ObsidianFileLike, oldPath?: string): void {
    queueMicrotask(() => {
      for (const handler of this.handlers.get(name) ?? []) handler(file, oldPath);
    });
  }
}
```

- [ ] **Step 2: Write the failing tests**

`packages/plugin/test/vaultAdapter.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { VaultEvent } from "../src/core/ports";
import { FileNotFoundError, ObsidianVaultAdapter } from "../src/obsidian/vaultAdapter";
import { FakeObsidianVault } from "./fakes/fakeObsidianVault";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const vault = new FakeObsidianVault();
  return { vault, adapter: new ObsidianVaultAdapter(vault) };
}

describe("ObsidianVaultAdapter", () => {
  it("lists markdown files and reads files only", async () => {
    const { vault, adapter } = setup();
    vault.seed("notes/a.md", "A");
    vault.seed("img.png", "binary");
    expect(await adapter.listFiles()).toEqual(["notes/a.md"]);
    expect(await adapter.read("notes/a.md")).toBe("A");
    expect(await adapter.read("notes")).toBeNull();
    expect(await adapter.read("missing.md")).toBeNull();
  });

  it("creates files with missing parent folders and refuses existing ones", async () => {
    const { vault, adapter } = setup();
    expect(await adapter.replace("deep/er/new.md", null, "hi")).toBe(true);
    expect(vault.files.get("deep/er/new.md")?.data).toBe("hi");
    expect(await adapter.replace("deep/er/new.md", null, "again")).toBe(false);
  });

  it("writes only when the disk still holds the expected text", async () => {
    const { vault, adapter } = setup();
    vault.seed("a.md", "v1");
    expect(await adapter.replace("a.md", "stale", "v2")).toBe(false);
    expect(vault.files.get("a.md")?.data).toBe("v1");
    expect(await adapter.replace("a.md", "v1", "v2")).toBe(true);
    expect(vault.files.get("a.md")?.data).toBe("v2");
    expect(await adapter.replace("gone.md", "x", "y")).toBe(false);
  });

  it("renames into new folders without link rewriting and fails on missing files", async () => {
    const { vault, adapter } = setup();
    vault.seed("a.md", "A");
    await adapter.rename("a.md", "x/y/b.md");
    expect(vault.files.get("x/y/b.md")?.data).toBe("A");
    await expect(adapter.rename("nope.md", "z.md")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("moves deletions to the vault trash", async () => {
    const { vault, adapter } = setup();
    vault.seed("a.md", "A");
    await adapter.trash("a.md");
    await adapter.trash("missing.md");
    expect(vault.trashed).toEqual([{ path: "a.md", system: false }]);
  });

  it("reports file events, ignores folder events and stops after unsubscribe", async () => {
    const { vault, adapter } = setup();
    const events: VaultEvent[] = [];
    const stop = adapter.onEvent((event) => events.push(event));
    await vault.createFolder("dir");
    await vault.create("dir/a.md", "A");
    vault.userModify("dir/a.md", "AA");
    await vault.rename(vault.getAbstractFileByPath("dir/a.md")!, "dir/b.md");
    await vault.trash(vault.getAbstractFileByPath("dir/b.md")!, true);
    await flush();
    expect(events).toEqual([
      { type: "create", path: "dir/a.md" },
      { type: "modify", path: "dir/a.md" },
      { type: "rename", oldPath: "dir/a.md", path: "dir/b.md" },
      { type: "delete", path: "dir/b.md" },
    ]);
    stop();
    await vault.create("c.md", "C");
    await flush();
    expect(events).toHaveLength(4);
  });

  it("turns a folder rename into renames of the markdown files inside it", async () => {
    const { vault, adapter } = setup();
    vault.seed("old/a.md", "A");
    vault.seed("old/sub/b.md", "B");
    vault.seed("old/pic.png", "P");
    const events: VaultEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await vault.rename(vault.getAbstractFileByPath("old")!, "new");
    await flush();
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "rename", oldPath: "old/a.md", path: "new/a.md" },
        { type: "rename", oldPath: "old/sub/b.md", path: "new/sub/b.md" },
      ]),
    );
    expect(events).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/vaultAdapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/plugin/src/obsidian/vaultAdapter.ts`:
```ts
import type { VaultEvent, VaultPort } from "../core/ports";

export interface ObsidianFileLike {
  path: string;
  extension?: string;
  children?: unknown;
}

/** Opaque handle returned by Vault.on (Obsidian's EventRef). */
export type VaultEventRef = { readonly __vaultEventRef?: never };

/** The subset of Obsidian's Vault the adapter uses; Obsidian's Vault satisfies it structurally. */
export interface ObsidianVaultLike {
  getMarkdownFiles(): ObsidianFileLike[];
  getAbstractFileByPath(path: string): ObsidianFileLike | null;
  read(file: ObsidianFileLike): Promise<string>;
  create(path: string, data: string): Promise<unknown>;
  process(file: ObsidianFileLike, fn: (data: string) => string): Promise<string>;
  rename(file: ObsidianFileLike, newPath: string): Promise<void>;
  trash(file: ObsidianFileLike, system: boolean): Promise<void>;
  createFolder(path: string): Promise<unknown>;
  on(name: "create" | "modify" | "delete", callback: (file: ObsidianFileLike) => unknown): VaultEventRef;
  on(name: "rename", callback: (file: ObsidianFileLike, oldPath: string) => unknown): VaultEventRef;
  offref(ref: VaultEventRef): void;
}

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`file not found in vault: ${path}`);
    this.name = "FileNotFoundError";
  }
}

const isFile = (entry: ObsidianFileLike | null): entry is ObsidianFileLike => entry !== null && typeof entry.extension === "string";
const isFolder = (entry: ObsidianFileLike): boolean => entry.children !== undefined;
const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export class ObsidianVaultAdapter implements VaultPort {
  constructor(private readonly vault: ObsidianVaultLike) {}

  async listFiles(): Promise<string[]> {
    return this.vault.getMarkdownFiles().map((file) => file.path);
  }

  async read(path: string): Promise<string | null> {
    const file = this.vault.getAbstractFileByPath(path);
    return isFile(file) ? this.vault.read(file) : null;
  }

  async replace(path: string, expected: string | null, next: string): Promise<boolean> {
    if (expected === null) return this.createIfAbsent(path, next);
    const file = this.vault.getAbstractFileByPath(path);
    if (!isFile(file)) return false;
    let swapped = false;
    // Vault.process is Obsidian's atomic read-modify-write: the compare and the write cannot interleave.
    await this.vault.process(file, (data) => {
      if (data !== expected) return data;
      swapped = true;
      return next;
    });
    return swapped;
  }

  /** Sync-applied rename: Vault.rename, not FileManager.renameFile — links were already rewritten on the origin device. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(oldPath);
    if (!isFile(file)) throw new FileNotFoundError(oldPath);
    await this.ensureFolder(parentOf(newPath));
    await this.vault.rename(file, newPath);
  }

  /** Vault `.trash`, regardless of the user's delete setting, so a synced delete is always recoverable. */
  async trash(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (isFile(file)) await this.vault.trash(file, false);
  }

  onEvent(listener: (event: VaultEvent) => void): () => void {
    const refs = [
      this.vault.on("create", (file) => isFile(file) && listener({ type: "create", path: file.path })),
      this.vault.on("modify", (file) => isFile(file) && listener({ type: "modify", path: file.path })),
      this.vault.on("delete", (file) => isFile(file) && listener({ type: "delete", path: file.path })),
      this.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath, listener)),
    ];
    return () => refs.forEach((ref) => this.vault.offref(ref));
  }

  private onRename(file: ObsidianFileLike, oldPath: string, listener: (event: VaultEvent) => void): void {
    if (isFile(file)) return listener({ type: "rename", oldPath, path: file.path });
    if (!isFolder(file)) return;
    // Obsidian may report only the folder; report each moved note. Duplicates of per-file events are harmless:
    // the engine finds no record at the old path the second time and just reconciles the known file.
    const prefix = `${file.path}/`;
    for (const moved of this.vault.getMarkdownFiles().filter((entry) => entry.path.startsWith(prefix))) {
      listener({ type: "rename", oldPath: `${oldPath}/${moved.path.slice(prefix.length)}`, path: moved.path });
    }
  }

  private async createIfAbsent(path: string, text: string): Promise<boolean> {
    if (this.vault.getAbstractFileByPath(path)) return false;
    await this.ensureFolder(parentOf(path));
    try {
      await this.vault.create(path, text);
      return true;
    } catch (error) {
      if (this.vault.getAbstractFileByPath(path)) return false; // lost a race with another writer
      throw error;
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path || this.vault.getAbstractFileByPath(path)) return;
    await this.ensureFolder(parentOf(path));
    try {
      await this.vault.createFolder(path);
    } catch (error) {
      if (!this.vault.getAbstractFileByPath(path)) throw error;
    }
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/vaultAdapter.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin
git commit -m "feat(plugin): implement VaultPort over the Obsidian Vault API"
```

---

### Task 6: CodeMirror ⇄ Y.Text binding primitives

**Files:**
- Create: `packages/plugin/src/editor/editorSync.ts`
- Test: `packages/plugin/test/editorSync.test.ts`

**Interfaces:**
- Consumes: `diffByCodePoint` (core `textDiff.ts`); `yCollab`, `yUndoManagerKeymap` (y-codemirror.next); `Awareness` (y-protocols).
- Produces:
  - `interface EditorUser { name: string; color: string; colorLight: string }`
  - `interface SyncTarget { path: string; text: Y.Text; awareness: Awareness | null; user: EditorUser }`
  - `type FileOf = (state: EditorState) => string | null`
  - `editorSyncExtension(fileOf: FileOf): Extension` (install once per editor)
  - `attachSync(view: EditorView, target: SyncTarget): void`, `detachSync(view: EditorView): void`, `boundPathOf(state: EditorState): string | null`
  - `alignmentChanges(current: string, next: string): Array<{ from: number; to: number; insert: string }>`

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/editorSync.test.ts`:
```ts
// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { alignmentChanges, attachSync, boundPathOf, detachSync, editorSyncExtension } from "../src/editor/editorSync";

const USER = { name: "A", color: "#f00", colorLight: "#f003" };
const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function editor(doc: string, info: { path: string | null }) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [editorSyncExtension(() => info.path)] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function yText(content: string): Y.Text {
  const text = new Y.Doc().getText("content");
  text.insert(0, content);
  return text;
}

const type = (view: EditorView, at: number, insert: string) => view.dispatch({ changes: { from: at, insert } });

describe("editorSync", () => {
  it("aligns the editor to the Y.Text without changing the Y.Text", () => {
    const text = yText("new text");
    let updates = 0;
    text.doc!.on("update", () => updates++);
    const view = editor("old", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    expect(view.state.doc.toString()).toBe("new text");
    expect(updates).toBe(0);
    expect(boundPathOf(view.state)).toBe("a.md");
  });

  it("syncs typing to the Y.Text and remote edits to the editor", () => {
    const text = yText("hello");
    const view = editor("hello", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: new Awareness(text.doc!), user: USER });
    type(view, 5, " world");
    expect(text.toString()).toBe("hello world");
    text.insert(0, ">> ");
    expect(view.state.doc.toString()).toBe(">> hello world");
  });

  it("stops syncing after detach", () => {
    const text = yText("hello");
    const view = editor("hello", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    detachSync(view);
    type(view, 0, "x");
    expect(text.toString()).toBe("hello");
    expect(boundPathOf(view.state)).toBeNull();
  });

  it("never pushes another file's content into the bound Y.Text when the view switches files", () => {
    const text = yText("note A");
    const info = { path: "a.md" as string | null };
    const view = editor("note A", info);
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    info.path = "b.md"; // Obsidian's file getter changes before it loads the new content
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "note B" } });
    expect(text.toString()).toBe("note A");
    expect(boundPathOf(view.state)).toBeNull();
  });

  it("keeps emoji intact when aligning", () => {
    const text = yText("x😁y");
    const view = editor("x😀y", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    expect(view.state.doc.toString()).toBe("x😁y");
  });

  it("undoes local typing through the Yjs undo manager", () => {
    const text = yText("abc");
    const view = editor("abc", { path: "a.md" });
    attachSync(view, { path: "a.md", text, awareness: null, user: USER });
    type(view, 3, "d");
    const undo = yUndoManagerKeymap.find((binding) => binding.key === "Mod-z")!;
    undo.run!(view);
    expect(text.toString()).toBe("abc");
  });

  it("computes minimal changes in original positions", () => {
    expect(alignmentChanges("abcdef", "abXdeYf")).toEqual([
      { from: 2, to: 3, insert: "" },
      { from: 3, to: 3, insert: "X" },
      { from: 5, to: 5, insert: "Y" },
    ]);
  });
});
```

> The last expectation follows diff-match-patch's output order (delete before insert at the same position). If the library groups the edit differently, assert instead that applying the returned changes to `"abcdef"` with `EditorState.create({ doc: "abcdef" }).update({ changes }).state.doc.toString()` yields `"abXdeYf"`, and keep that as the test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/editorSync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/plugin/src/editor/editorSync.ts`:
```ts
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { diffByCodePoint } from "../core/textDiff";

export interface EditorUser {
  name: string;
  color: string;
  colorLight: string;
}

export interface SyncTarget {
  path: string;
  text: Y.Text;
  awareness: Awareness | null;
  user: EditorUser;
}

/** Which vault file the editor state currently shows (Obsidian: editorInfoField's live `file` getter). */
export type FileOf = (state: EditorState) => string | null;

const syncCompartment = new Compartment();
const setBoundPath = StateEffect.define<string | null>();
const boundPathField = StateField.define<string | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBoundPath)) return effect.value;
    return value;
  },
});
const undoManagers = new WeakMap<EditorView, Y.UndoManager>();

/** Installed once per editor; empty until attachSync binds a Y.Text. */
export function editorSyncExtension(fileOf: FileOf): Extension {
  return [syncCompartment.of([]), boundPathField, fileSwitchGuard(fileOf)];
}

export function boundPathOf(state: EditorState): string | null {
  return state.field(boundPathField, false) ?? null;
}

export function attachSync(view: EditorView, target: SyncTarget): void {
  target.awareness?.setLocalStateField("user", target.user);
  const undoManager = new Y.UndoManager(target.text);
  undoManagers.set(view, undoManager);
  // One transaction: align the editor to the Y.Text and install yCollab together, so the alignment is not
  // replayed into the Y.Text and no remote update can land in between.
  view.dispatch({
    changes: alignmentChanges(view.state.doc.toString(), target.text.toString()),
    effects: [
      syncCompartment.reconfigure([yCollab(target.text, target.awareness, { undoManager }), Prec.highest(keymap.of(yUndoManagerKeymap))]),
      setBoundPath.of(target.path),
    ],
  });
}

export function detachSync(view: EditorView): void {
  // A destroyed editor (pane closed) is no longer in the DOM and must not receive transactions.
  if (boundPathOf(view.state) !== null && view.dom.isConnected) view.dispatch({ effects: [syncCompartment.reconfigure([]), setBoundPath.of(null)] });
  undoManagers.get(view)?.destroy();
  undoManagers.delete(view);
}

/**
 * Spec §9 risk: Obsidian may reuse one editor for another file. When the shown file no longer matches the bound
 * path, the binding is removed in the same transaction, so yCollab never sees the new file's content.
 */
function fileSwitchGuard(fileOf: FileOf): Extension {
  return EditorState.transactionExtender.of((transaction: Transaction) => {
    const bound = transaction.startState.field(boundPathField, false) ?? null;
    if (bound === null || fileOf(transaction.startState) === bound) return null;
    return { effects: [syncCompartment.reconfigure([]), setBoundPath.of(null)] };
  });
}

/** Code-point-safe changes, in positions of `current`, that turn `current` into `next`. */
export function alignmentChanges(current: string, next: string): Array<{ from: number; to: number; insert: string }> {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let position = 0;
  for (const edit of diffByCodePoint(current, next)) {
    if (edit.op === "equal") position += edit.text.length;
    else if (edit.op === "delete") {
      changes.push({ from: position, to: position + edit.text.length, insert: "" });
      position += edit.text.length;
    } else changes.push({ from: position, to: position, insert: edit.text });
  }
  return changes;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/editorSync.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0. If the file-switch test fails because the removed yCollab plugin still processes the transaction, stop and report BLOCKED with the observed behaviour — the guard is a spec §9 safety requirement and needs a design decision, not a weaker test.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin
git commit -m "feat(editor): bind CodeMirror to Y.Text with a file-switch guard"
```

---

### Task 7: Editor bridge — per-view binding lifecycle

**Files:**
- Create: `packages/plugin/src/editor/editorBridge.ts`
- Test: `packages/plugin/test/editorBridge.test.ts`

**Interfaces:**
- Consumes: `editorSyncExtension`, `attachSync`, `detachSync`, `boundPathOf`, `FileOf`, `EditorUser` (Task 6); `EditorDoc` (Task 2).
- Produces:
  - `interface EditorDocSource { openDocForPath(path: string): Promise<EditorDoc | null>; captureEditorSnapshot(path: string): void; notifyEditorClosed(path: string): void }` (`SyncEngine` satisfies it)
  - `interface EditorBridgeDeps { getSource(): EditorDocSource | null; getUser(): EditorUser; fileOf: FileOf; saveEditor(view: EditorView, path: string): Promise<void>; retry?: { attempts: number; delayMs: number } }`
  - `class EditorBridge { constructor(deps); extension(): Extension; isOpen(path: string): boolean; detachAll(): Promise<void>; refreshAll(): void }`, `BIND_RETRY = { attempts: 10, delayMs: 300 }`

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/editorBridge.test.ts`:
```ts
// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EditorDoc } from "../src/core/syncEngine";
import { EditorBridge, type EditorDocSource } from "../src/editor/editorBridge";

const USER = { name: "A", color: "#f00", colorLight: "#f003" };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSource implements EditorDocSource {
  readonly texts = new Map<string, Y.Text>();
  readonly calls: string[] = [];
  track(path: string, content: string): Y.Text {
    const text = new Y.Doc().getText("content");
    text.insert(0, content);
    this.texts.set(path, text);
    return text;
  }
  async openDocForPath(path: string): Promise<EditorDoc | null> {
    const text = this.texts.get(path);
    return text ? { fileId: path, text, awareness: null } : null;
  }
  captureEditorSnapshot(path: string): void {
    this.calls.push(`capture:${path}`);
  }
  notifyEditorClosed(path: string): void {
    this.calls.push(`closed:${path}`);
  }
}

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function setup() {
  const source = new FakeSource();
  const files = new Map<EditorView, { path: string | null }>();
  const bridge = new EditorBridge({
    getSource: () => source,
    getUser: () => USER,
    fileOf: (state) => [...files.entries()].find(([view]) => view.state === state)?.[1].path ?? pendingPath,
    saveEditor: async (_view, path) => {
      source.calls.push(`save:${path}`);
    },
    retry: { attempts: 5, delayMs: 5 },
  });
  let pendingPath: string | null = null;
  const open = (path: string, content: string) => {
    pendingPath = path;
    const info = { path: path as string | null };
    const view = new EditorView({ state: EditorState.create({ doc: content, extensions: [bridge.extension()] }), parent: document.body });
    files.set(view, info);
    views.push(view);
    return { view, info };
  };
  return { source, bridge, open };
}

describe("EditorBridge", () => {
  it("binds an opened file and syncs typing", async () => {
    const { source, bridge, open } = setup();
    const text = source.track("a.md", "hello");
    const { view } = open("a.md", "hello");
    await tick();
    view.dispatch({ changes: { from: 5, insert: "!" } });
    expect(text.toString()).toBe("hello!");
    expect(bridge.isOpen("a.md")).toBe(true);
  });

  it("captures, saves and only then reports a closed editor", async () => {
    const { source, bridge, open } = setup();
    source.track("a.md", "hello");
    const { view } = open("a.md", "hello");
    await tick();
    views.splice(views.indexOf(view), 1);
    view.destroy();
    await tick();
    expect(source.calls).toEqual(["capture:a.md", "save:a.md", "closed:a.md"]);
    expect(bridge.isOpen("a.md")).toBe(false);
  });

  it("rebinds when the view switches files, without saving or touching the old text", async () => {
    const { source, open } = setup();
    const a = source.track("a.md", "note A");
    const b = source.track("b.md", "note B");
    const { view, info } = open("a.md", "note A");
    await tick();
    info.path = "b.md";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "note B" } });
    await tick();
    view.dispatch({ changes: { from: 6, insert: "!" } });
    expect(a.toString()).toBe("note A");
    expect(b.toString()).toBe("note B!");
    expect(source.calls).toEqual(["capture:a.md", "closed:a.md"]);
  });

  // Review Focus 1
  it("keeps a file open while another pane still shows it", async () => {
    const { source, bridge, open } = setup();
    source.track("a.md", "x");
    const first = open("a.md", "x");
    const second = open("a.md", "x");
    await tick();
    views.splice(views.indexOf(first.view), 1);
    first.view.destroy();
    await tick();
    expect(bridge.isOpen("a.md")).toBe(true);
    expect(source.calls).not.toContain("closed:a.md");
    views.splice(views.indexOf(second.view), 1);
    second.view.destroy();
    await tick();
    expect(source.calls.filter((call) => call === "closed:a.md")).toHaveLength(1);
  });

  // Review Focus 2
  it("retries binding until the engine tracks the file, and gives up quietly", async () => {
    const { source, bridge, open } = setup();
    const late = open("new.md", "");
    const never = open("huge.md", "big");
    await tick(8);
    const text = source.track("new.md", "");
    await tick(30);
    late.view.dispatch({ changes: { from: 0, insert: "typed" } });
    expect(text.toString()).toBe("typed");
    expect(bridge.isOpen("huge.md")).toBe(false);
    never.view.dispatch({ changes: { from: 0, insert: "x" } });
  });

  // Review Focus 3
  it("follows a rename of the open file", async () => {
    const { source, bridge, open } = setup();
    const text = source.track("old.md", "body");
    const { view, info } = open("old.md", "body");
    await tick();
    source.texts.set("new.md", text);
    info.path = "new.md";
    view.dispatch({ selection: { anchor: 0 } }); // any transaction; the guard notices the path change
    await tick();
    view.dispatch({ changes: { from: 4, insert: "!" } });
    expect(text.toString()).toBe("body!");
    expect(bridge.isOpen("new.md")).toBe(true);
    expect(bridge.isOpen("old.md")).toBe(false);
  });

  it("detaches every editor for a session restart and binds them again", async () => {
    const { source, bridge, open } = setup();
    const text = source.track("a.md", "x");
    const { view } = open("a.md", "x");
    await tick();
    await bridge.detachAll();
    expect(source.calls).toEqual(["capture:a.md", "save:a.md", "closed:a.md"]);
    expect(bridge.isOpen("a.md")).toBe(false);
    bridge.refreshAll();
    await tick();
    view.dispatch({ changes: { from: 1, insert: "1" } });
    expect(text.toString()).toBe("x1");
    expect(bridge.isOpen("a.md")).toBe(true);
  });
});
```

> The `fileOf` helper resolves the path of a state through its view; during `EditorView` construction (before the view is registered) it falls back to `pendingPath`, mirroring Obsidian where the file is known when the editor is created.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/editorBridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/plugin/src/editor/editorBridge.ts`:
```ts
import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorDoc } from "../core/syncEngine";
import { attachSync, boundPathOf, detachSync, type EditorUser, editorSyncExtension, type FileOf } from "./editorSync";

export interface EditorDocSource {
  openDocForPath(path: string): Promise<EditorDoc | null>;
  captureEditorSnapshot(path: string): void;
  notifyEditorClosed(path: string): void;
}

export interface EditorBridgeDeps {
  getSource(): EditorDocSource | null;
  getUser(): EditorUser;
  fileOf: FileOf;
  saveEditor(view: EditorView, path: string): Promise<void>;
  retry?: { attempts: number; delayMs: number };
}

/** A new note is registered by the engine a moment after the editor opens it. */
export const BIND_RETRY = { attempts: 10, delayMs: 300 };

interface Binding {
  path: string;
  generation: number;
  attached: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class EditorBridge {
  private readonly views = new Set<EditorView>();
  private readonly bindings = new Map<EditorView, Binding>();
  private readonly openCounts = new Map<string, number>();
  private generation = 0;

  constructor(private readonly deps: EditorBridgeDeps) {}

  extension(): Extension {
    const bridge = this;
    return [
      editorSyncExtension(this.deps.fileOf),
      ViewPlugin.define((view) => {
        bridge.views.add(view);
        bridge.schedule(view);
        return {
          update: (update: ViewUpdate) => bridge.onUpdate(update),
          destroy: () => {
            bridge.views.delete(view);
            void bridge.release(view, true);
          },
        };
      }),
    ];
  }

  isOpen(path: string): boolean {
    return (this.openCounts.get(path) ?? 0) > 0;
  }

  /** Before a session stops: every bound editor is captured, saved and reported closed. */
  async detachAll(): Promise<void> {
    await Promise.all([...this.bindings.keys()].map((view) => this.release(view, true)));
  }

  /** After a session starts: bind every open editor again. */
  refreshAll(): void {
    for (const view of this.views) this.schedule(view);
  }

  private onUpdate(update: ViewUpdate): void {
    const binding = this.bindings.get(update.view);
    const path = this.deps.fileOf(update.state);
    const guardDetached = binding?.attached === true && boundPathOf(update.state) === null;
    if (path !== (binding?.path ?? null) || guardDetached) this.schedule(update.view);
  }

  /** Never dispatch inside a CodeMirror update: defer to a microtask. */
  private schedule(view: EditorView): void {
    queueMicrotask(() => void this.sync(view));
  }

  private async sync(view: EditorView): Promise<void> {
    if (!this.views.has(view)) return;
    const path = this.deps.fileOf(view.state);
    const binding = this.bindings.get(view);
    if (binding && binding.path === path && (!binding.attached || boundPathOf(view.state) === path)) return;
    if (binding) await this.release(view, false); // switched or renamed: Obsidian already saved the old file
    if (path) await this.bind(view, path);
  }

  private async bind(view: EditorView, path: string): Promise<void> {
    const generation = ++this.generation;
    this.bindings.set(view, { path, generation, attached: false });
    const { attempts, delayMs } = this.deps.retry ?? BIND_RETRY;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const doc = (await this.deps.getSource()?.openDocForPath(path)) ?? null;
      if (!this.isCurrent(view, generation, path)) return;
      if (doc) return this.attach(view, path, doc);
      await sleep(delayMs);
      if (!this.isCurrent(view, generation, path)) return;
    }
  }

  private attach(view: EditorView, path: string, doc: EditorDoc): void {
    attachSync(view, { path, text: doc.text, awareness: doc.awareness, user: this.deps.getUser() });
    this.openCounts.set(path, (this.openCounts.get(path) ?? 0) + 1);
    const binding = this.bindings.get(view);
    if (binding) binding.attached = true;
  }

  private isCurrent(view: EditorView, generation: number, path: string): boolean {
    return this.views.has(view) && this.bindings.get(view)?.generation === generation && this.deps.fileOf(view.state) === path;
  }

  /** Spec §9 close order: capture → save → detach → notify (only when no other pane shows the file). */
  private async release(view: EditorView, save: boolean): Promise<void> {
    const binding = this.bindings.get(view);
    if (!binding) return;
    this.bindings.delete(view);
    if (!binding.attached) return;
    const source = this.deps.getSource();
    source?.captureEditorSnapshot(binding.path);
    try {
      if (save) await this.deps.saveEditor(view, binding.path);
    } finally {
      detachSync(view);
      const remaining = (this.openCounts.get(binding.path) ?? 1) - 1;
      if (remaining > 0) this.openCounts.set(binding.path, remaining);
      else this.openCounts.delete(binding.path);
      if (remaining <= 0) source?.notifyEditorClosed(binding.path);
    }
  }
}
```

> `release` is called from `ViewPlugin.destroy`, when the view is being torn down; `detachSync` skips the dispatch for a view whose DOM is no longer connected and only destroys the undo manager.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/editorBridge.test.ts packages/plugin/test/editorSync.test.ts && npm run typecheck`
Expected: PASS (run 3 times — async timing); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin
git commit -m "feat(editor): manage per-view binding lifecycle with safe close order"
```

---

### Task 8: Settings, status and messages

**Files:**
- Create: `packages/plugin/src/settings/settings.ts`, `packages/plugin/src/settings/settingTab.ts` (glue), `packages/plugin/src/session/status.ts`, `packages/plugin/src/session/messages.ts`
- Test: `packages/plugin/test/settings.test.ts`, `packages/plugin/test/messages.test.ts`

**Interfaces:**
- Consumes: `assertSecureServerUrl`, `InsecureServerUrlError` (core); `isValidVaultId` (shared); `SyncNotice` (core).
- Produces:
  - `interface PluginSettings { enabled: boolean; serverUrl: string; vaultId: string; tokenSecretId: string; deviceName: string; debugLogging: boolean }`, `DEFAULT_SETTINGS`
  - `mergeSettings(raw: unknown): PluginSettings`
  - `interface SessionConfig { serverUrl: string; vaultId: string; token: string; deviceName: string }`
  - `resolveSessionConfig(settings: PluginSettings, getSecret: (id: string) => string | null): { ok: true; config: SessionConfig } | { ok: false; problems: string[] }`
  - `userColor(name: string): { color: string; colorLight: string }`
  - `type SyncStatus = "stopped" | "starting" | "waiting-first-sync" | "connected" | "offline" | "auth-failed" | "deletes-paused" | "error"`
  - `noticeMessage(notice: SyncNotice): string`, `statusLabel(status: SyncStatus): string`
  - `class CrdtSyncSettingTab extends PluginSettingTab` (glue; constructor `(app: App, host: SettingsHost)` with `SettingsHost { settings: PluginSettings; saveSettings(): Promise<void>; restartSession(): Promise<void> }`)

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/settings.test.ts`:
```ts
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
```

`packages/plugin/test/messages.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { SyncNotice } from "../src/core/notices";
import { noticeMessage, statusLabel } from "../src/session/messages";
import type { SyncStatus } from "../src/session/status";

describe("messages", () => {
  it("describes every notice kind with its paths", () => {
    const notices: SyncNotice[] = [
      { kind: "waiting-for-first-sync" },
      { kind: "conflict-copy", path: "a.md", copyPath: "a (conflict-disk 2026-10-08 abcdef).md" },
      { kind: "file-too-large", path: "big.md" },
      { kind: "mass-delete-paused", paths: ["1.md", "2.md"] },
      { kind: "task-failed", message: "boom" },
    ];
    const texts = notices.map(noticeMessage);
    expect(new Set(texts).size).toBe(notices.length);
    expect(texts[1]).toContain("a (conflict-disk 2026-10-08 abcdef).md");
    expect(texts[2]).toContain("big.md");
    expect(texts[3]).toContain("2");
  });

  it("labels every status", () => {
    const statuses: SyncStatus[] = ["stopped", "starting", "waiting-first-sync", "connected", "offline", "auth-failed", "deletes-paused", "error"];
    expect(new Set(statuses.map(statusLabel)).size).toBe(statuses.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/settings.test.ts packages/plugin/test/messages.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the pure modules**

`packages/plugin/src/settings/settings.ts`:
```ts
import { isValidVaultId } from "@obsidian-crdt/shared";
import { assertSecureServerUrl, InsecureServerUrlError } from "../core/serverUrl";

export interface PluginSettings {
  enabled: boolean;
  serverUrl: string;
  vaultId: string;
  /** Id of the token in Obsidian's SecretStorage; the token itself never goes into data.json. */
  tokenSecretId: string;
  deviceName: string;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: false,
  serverUrl: "",
  vaultId: "",
  tokenSecretId: "crdt-sync-token",
  deviceName: "Obsidian",
  debugLogging: false,
};

const SECRET_ID_PATTERN = /^[a-z0-9-]+$/;
const HUE_RANGE = 360;

export interface SessionConfig {
  serverUrl: string;
  vaultId: string;
  token: string;
  deviceName: string;
}

export type ConfigResult = { ok: true; config: SessionConfig } | { ok: false; problems: string[] };

function pick<K extends keyof PluginSettings>(raw: Record<string, unknown>, key: K): PluginSettings[K] {
  const value = raw[key];
  return typeof value === typeof DEFAULT_SETTINGS[key] ? (value as PluginSettings[K]) : DEFAULT_SETTINGS[key];
}

export function mergeSettings(raw: unknown): PluginSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS };
  const source = raw as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof PluginSettings>;
  return Object.fromEntries(keys.map((key) => [key, pick(source, key)])) as unknown as PluginSettings;
}

export function resolveSessionConfig(settings: PluginSettings, getSecret: (id: string) => string | null): ConfigResult {
  const problems: string[] = [];
  try {
    assertSecureServerUrl(settings.serverUrl);
  } catch (error) {
    if (!(error instanceof InsecureServerUrlError)) throw error;
    problems.push("서버 주소는 wss://로 시작해야 합니다 (ws://는 localhost만 허용).");
  }
  if (!isValidVaultId(settings.vaultId)) problems.push("볼트 ID는 소문자, 숫자, -로 된 8~64자여야 합니다.");
  const token = SECRET_ID_PATTERN.test(settings.tokenSecretId) ? getSecret(settings.tokenSecretId) : null;
  if (!SECRET_ID_PATTERN.test(settings.tokenSecretId)) problems.push("토큰 비밀 ID는 소문자, 숫자, -만 쓸 수 있습니다.");
  else if (!token) problems.push("토큰이 비밀 저장소에 없습니다. 설정에서 토큰을 입력하세요.");
  if (problems.length > 0 || !token) return { ok: false, problems };
  return { ok: true, config: { serverUrl: settings.serverUrl, vaultId: settings.vaultId, token, deviceName: settings.deviceName } };
}

/** Deterministic cursor color per device name, so collaborators recognise each other across sessions. */
export function userColor(name: string): { color: string; colorLight: string } {
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0;
  const hue = Math.abs(hash) % HUE_RANGE;
  return { color: `hsl(${hue} 70% 45%)`, colorLight: `hsl(${hue} 70% 45% / 0.25)` };
}
```

`packages/plugin/src/session/status.ts`:
```ts
export type SyncStatus =
  | "stopped"
  | "starting"
  | "waiting-first-sync"
  | "connected"
  | "offline"
  | "auth-failed"
  | "deletes-paused"
  | "error";
```

`packages/plugin/src/session/messages.ts`:
```ts
import type { SyncNotice } from "../core/notices";
import type { SyncStatus } from "./status";

const MAX_LISTED_PATHS = 5;

export function noticeMessage(notice: SyncNotice): string {
  switch (notice.kind) {
    case "waiting-for-first-sync":
      return "CRDT Sync: 첫 동기화는 서버 연결이 필요합니다. 연결을 기다리는 중입니다.";
    case "conflict-copy":
      return `CRDT Sync: ${notice.path}의 디스크 내용이 서버와 달라 ${notice.copyPath}에 따로 저장했습니다.`;
    case "file-too-large":
      return `CRDT Sync: ${notice.path}은(는) 2MB를 넘어 동기화하지 않습니다.`;
    case "mass-delete-paused": {
      const listed = notice.paths.slice(0, MAX_LISTED_PATHS).join(", ");
      return `CRDT Sync: 파일 ${notice.paths.length}개가 한꺼번에 삭제되어 동기화를 멈췄습니다 (${listed}). 확인 창에서 선택하세요.`;
    }
    case "task-failed":
      return `CRDT Sync: 작업 하나가 실패했습니다 — ${notice.message}`;
  }
}

const STATUS_LABELS: Record<SyncStatus, string> = {
  stopped: "꺼짐",
  starting: "시작 중",
  "waiting-first-sync": "첫 동기화 대기",
  connected: "동기화됨",
  offline: "오프라인",
  "auth-failed": "인증 실패",
  "deletes-paused": "삭제 확인 필요",
  error: "설정 오류",
};

export function statusLabel(status: SyncStatus): string {
  return STATUS_LABELS[status];
}
```

- [ ] **Step 4: Implement the setting tab (glue, typecheck only)**

`packages/plugin/src/settings/settingTab.ts`:
```ts
import { type App, type Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { PluginSettings } from "./settings";

export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  restartSession(): Promise<void>;
}

export class CrdtSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost & Plugin,
  ) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.host.settings;
    const save = async (change: Partial<PluginSettings>) => {
      Object.assign(settings, change);
      await this.host.saveSettings();
    };
    containerEl.empty();
    new Setting(containerEl).setName("동기화 켜기").addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (enabled) => {
        await save({ enabled });
        await this.host.restartSession();
      }),
    );
    new Setting(containerEl).setName("서버 주소").setDesc("wss://로 시작하는 주소").addText((text) =>
      text.setPlaceholder("wss://sync.example.com").setValue(settings.serverUrl).onChange((serverUrl) => save({ serverUrl: serverUrl.trim() })),
    );
    new Setting(containerEl).setName("볼트 ID").setDesc("서버에서 토큰을 만들 때 쓴 ID").addText((text) =>
      text.setValue(settings.vaultId).onChange((vaultId) => save({ vaultId: vaultId.trim() })),
    );
    new Setting(containerEl)
      .setName("토큰")
      .setDesc("Obsidian 비밀 저장소에 보관됩니다. data.json에는 저장되지 않습니다.")
      .addComponent((el) => new SecretComponent(this.app, el).setValue(settings.tokenSecretId).onChange((tokenSecretId) => save({ tokenSecretId })));
    new Setting(containerEl).setName("기기 이름").setDesc("다른 기기에서 커서 옆에 표시됩니다").addText((text) =>
      text.setValue(settings.deviceName).onChange((deviceName) => save({ deviceName: deviceName.trim() || "Obsidian" })),
    );
    new Setting(containerEl).setName("디버그 로그").addToggle((toggle) =>
      toggle.setValue(settings.debugLogging).onChange((debugLogging) => save({ debugLogging })),
    );
    new Setting(containerEl).addButton((button) => button.setButtonText("적용하고 다시 연결").setCta().onClick(() => void this.host.restartSession()));
  }
}
```

> `SecretComponent.onChange` reports the selected/entered **secret id**; Obsidian stores the value in `app.secretStorage`. If the 1.13 typings show it reports the secret value instead, store it with `this.app.secretStorage.setSecret(settings.tokenSecretId, value)` in `onChange` and keep only the id in settings — never put the token into `PluginSettings`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run packages/plugin/test/settings.test.ts packages/plugin/test/messages.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin
git commit -m "feat(plugin): settings with SecretStorage token, Korean notices and status labels"
```

---

### Task 9: Sync session, plugin lifecycle and UI glue

**Files:**
- Create: `packages/plugin/src/session/syncSession.ts`, `packages/plugin/src/ui/statusBar.ts`, `packages/plugin/src/ui/massDeleteModal.ts`
- Modify: `packages/plugin/src/main.ts` (replace stub)
- Test: `packages/plugin/test/syncSession.test.ts`

**Interfaces:**
- Consumes: `SyncEngine`, `EngineStoppedError`, `SyncTiming`, ports (core); `HocuspocusSyncer`, `ConnectionStatus` (core); `IdbStorage`, `IdbDocPersistence`, `openSyncDatabase` (Task 4); `ObsidianVaultAdapter` (Task 5); `EditorBridge` (Task 7); settings/messages/status (Task 8).
- Produces:
  - `interface SessionSyncer extends DocSyncer { pause(): void; resume(): void; destroy(): void }`
  - `interface SessionStorage { storage: StoragePort; persistence: DocPersistence; flush(): Promise<void>; close(): void }`
  - `interface SessionDeps { config; vault; openStorage(config): Promise<SessionStorage>; createSyncer(config, handlers: { onAuthFailed(): void; onStatus(status: ConnectionStatus): void }): SessionSyncer; isOpenInEditor(path): boolean; excludedPrefixes: readonly string[]; onStatus(status: SyncStatus): void; onNotice(notice: SyncNotice): void; timing?: Partial<SyncTiming> }`
  - `class SyncSession { constructor(deps); readonly status: SyncStatus; editorSource: EditorDocSource | null; start(): Promise<void>; stop(): Promise<void>; pause(): void; resume(): void; confirmDeletes(): Promise<void>; restoreDeletes(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/syncSession.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import type { SyncNotice } from "../src/core/notices";
import { type SessionDeps, type SessionSyncer, SyncSession } from "../src/session/syncSession";
import type { SyncStatus } from "../src/session/status";
import { FAST_TIMING, TEST_VAULT_ID } from "./fakes/device";
import { FakeVault } from "./fakes/fakeVault";
import { LoopbackHub, LoopbackSyncer } from "./fakes/loopback";
import { MemoryPersistence } from "./fakes/memoryPersistence";
import { MemoryStorage } from "./fakes/memoryStorage";

const CONFIG = { serverUrl: "wss://example.test", vaultId: TEST_VAULT_ID, token: "t", deviceName: "A" };
const sessions: SyncSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
});

class TestSyncer extends LoopbackSyncer implements SessionSyncer {
  destroyed = false;
  pause(): void {
    this.setOnline(false);
  }
  resume(): void {
    this.setOnline(true);
  }
  destroy(): void {
    this.destroyed = true;
    this.setOnline(false);
  }
}

function makeSession(hub: LoopbackHub, overrides: Partial<SessionDeps> = {}) {
  const statuses: SyncStatus[] = [];
  const notices: SyncNotice[] = [];
  const vault = new FakeVault();
  const log: string[] = [];
  let syncer: TestSyncer | null = null;
  let authFailed: (() => void) | null = null;
  const session = new SyncSession({
    config: CONFIG,
    vault,
    openStorage: async () => ({
      storage: new MemoryStorage(),
      persistence: new MemoryPersistence(),
      flush: async () => void log.push("flush"),
      close: () => void log.push("close"),
    }),
    createSyncer: (_config, handlers) => {
      syncer = new TestSyncer(hub);
      authFailed = handlers.onAuthFailed;
      return syncer;
    },
    isOpenInEditor: () => false,
    excludedPrefixes: [".obsidian/"],
    onStatus: (status) => statuses.push(status),
    onNotice: (notice) => notices.push(notice),
    timing: FAST_TIMING,
    ...overrides,
  });
  sessions.push(session);
  return { session, vault, statuses, notices, log, syncer: () => syncer!, failAuth: () => authFailed!() };
}

const settleAll = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("SyncSession", () => {
  it("starts, syncs files between two sessions and reports connected", async () => {
    const hub = new LoopbackHub();
    const a = makeSession(hub);
    const b = makeSession(hub);
    await a.session.start();
    await b.session.start();
    a.vault.externalWrite("n.md", "hi");
    await settleAll();
    expect(b.vault.files.get("n.md")).toBe("hi");
    expect(a.statuses).toEqual(["starting", "connected"]);
  });

  it("stops by flushing storage, closing it and destroying the syncer", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    await a.session.stop();
    expect(a.log).toEqual(["flush", "close"]);
    expect(a.syncer().destroyed).toBe(true);
    expect(a.session.status).toBe("stopped");
  });

  it("reports an authentication failure and stops the engine", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    a.failAuth();
    await settleAll();
    expect(a.session.status).toBe("auth-failed");
    expect(a.session.editorSource).toBeNull();
  });

  // Review Focus 5
  it("stop during start releases everything", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const log: string[] = [];
    const a = makeSession(new LoopbackHub(), {
      openStorage: async () => {
        await gate;
        return { storage: new MemoryStorage(), persistence: new MemoryPersistence(), flush: async () => void log.push("flush"), close: () => void log.push("close") };
      },
    });
    const starting = a.session.start();
    const stopping = a.session.stop();
    release();
    await expect(starting).resolves.toBeUndefined();
    await stopping;
    expect(log).toEqual(["close"]);
    expect(a.session.status).toBe("stopped");
  });

  // Review Focus 4 (session half; the plugin restarts by stop() then a new session)
  it("restarting stops the old session before starting the new one", async () => {
    const hub = new LoopbackHub();
    const first = makeSession(hub);
    await first.session.start();
    await first.session.stop();
    const second = makeSession(hub, { vault: first.vault });
    await second.session.start();
    first.vault.externalWrite("after.md", "x");
    await settleAll();
    expect(first.syncer().destroyed).toBe(true);
    expect(hub.serverDoc(`${TEST_VAULT_ID}/index`).getMap("files").size).toBe(1);
  });

  it("enters deletes-paused on a mass delete and leaves it after a decision", async () => {
    const a = makeSession(new LoopbackHub());
    await a.session.start();
    for (const name of ["1", "2", "3", "4", "5"]) a.vault.externalWrite(`${name}.md`, name);
    await settleAll();
    for (const name of ["1", "2", "3", "4", "5"]) a.vault.externalDelete(`${name}.md`);
    await settleAll();
    expect(a.session.status).toBe("deletes-paused");
    await a.session.restoreDeletes();
    expect(a.session.status).toBe("connected");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin/test/syncSession.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the session**

`packages/plugin/src/session/syncSession.ts`:
```ts
import type { ConnectionStatus } from "../core/hocuspocusSyncer";
import type { SyncNotice } from "../core/notices";
import type { DocPersistence, DocSyncer, StoragePort, VaultPort } from "../core/ports";
import { EngineStoppedError, SyncEngine, type SyncTiming } from "../core/syncEngine";
import type { EditorDocSource } from "../editor/editorBridge";
import type { SessionConfig } from "../settings/settings";
import type { SyncStatus } from "./status";

export interface SessionSyncer extends DocSyncer {
  pause(): void;
  resume(): void;
  destroy(): void;
}

export interface SessionStorage {
  storage: StoragePort;
  persistence: DocPersistence;
  flush(): Promise<void>;
  close(): void;
}

export interface SyncerHandlers {
  onAuthFailed(): void;
  onStatus(status: ConnectionStatus): void;
}

export interface SessionDeps {
  config: SessionConfig;
  vault: VaultPort;
  openStorage(config: SessionConfig): Promise<SessionStorage>;
  createSyncer(config: SessionConfig, handlers: SyncerHandlers): SessionSyncer;
  isOpenInEditor(path: string): boolean;
  excludedPrefixes: readonly string[];
  onStatus(status: SyncStatus): void;
  onNotice(notice: SyncNotice): void;
  timing?: Partial<SyncTiming>;
}

/** One running sync: storage + syncer + engine, started and stopped together. */
export class SyncSession {
  private engine: SyncEngine | null = null;
  private storage: SessionStorage | null = null;
  private syncer: SessionSyncer | null = null;
  private connection: ConnectionStatus = "connecting";
  private stopped = false;
  private current: SyncStatus = "stopped";

  constructor(private readonly deps: SessionDeps) {}

  get status(): SyncStatus {
    return this.current;
  }

  get editorSource(): EditorDocSource | null {
    return this.stopped ? null : this.engine;
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    const storage = await this.deps.openStorage(this.deps.config);
    if (this.stopped) return storage.close(); // stop() ran while storage was opening
    this.storage = storage;
    this.syncer = this.deps.createSyncer(this.deps.config, {
      onAuthFailed: () => void this.failAuth(),
      onStatus: (status) => this.onConnection(status),
    });
    this.engine = this.createEngine(storage, this.syncer);
    try {
      await this.engine.start();
    } catch (error) {
      if (error instanceof EngineStoppedError) return;
      throw error;
    }
    if (this.current === "starting" || this.current === "waiting-first-sync") this.setStatus(this.connection === "disconnected" ? "offline" : "connected");
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.engine && !this.storage) return;
    this.stopped = true;
    const { engine, storage, syncer } = this;
    this.engine = null;
    this.storage = null;
    this.syncer = null;
    await engine?.stop();
    if (storage) {
      await storage.flush();
      storage.close();
    }
    syncer?.destroy();
    if (this.current !== "auth-failed") this.setStatus("stopped");
  }

  pause(): void {
    this.syncer?.pause();
  }

  resume(): void {
    this.syncer?.resume();
  }

  async confirmDeletes(): Promise<void> {
    await this.engine?.confirmPausedDeletes();
    this.leavePausedDeletes();
  }

  async restoreDeletes(): Promise<void> {
    await this.engine?.restorePausedDeletes();
    this.leavePausedDeletes();
  }

  private createEngine(storage: SessionStorage, syncer: SessionSyncer): SyncEngine {
    return new SyncEngine({
      vaultId: this.deps.config.vaultId,
      vault: this.deps.vault,
      storage: storage.storage,
      syncer,
      persistence: storage.persistence,
      isOpenInEditor: (path) => this.deps.isOpenInEditor(path),
      excludedPrefixes: this.deps.excludedPrefixes,
      notify: (notice) => this.onNotice(notice),
      timing: this.deps.timing,
    });
  }

  private onNotice(notice: SyncNotice): void {
    this.deps.onNotice(notice);
    if (notice.kind === "waiting-for-first-sync") this.setStatus("waiting-first-sync");
    if (notice.kind === "mass-delete-paused") this.setStatus("deletes-paused");
  }

  private onConnection(status: ConnectionStatus): void {
    this.connection = status;
    if (["auth-failed", "deletes-paused", "stopped", "starting", "waiting-first-sync"].includes(this.current)) return;
    if (status === "connected") this.setStatus("connected");
    if (status === "disconnected") this.setStatus("offline");
  }

  private async failAuth(): Promise<void> {
    this.setStatus("auth-failed");
    await this.stop();
  }

  private leavePausedDeletes(): void {
    if (this.current === "deletes-paused") this.setStatus(this.connection === "disconnected" ? "offline" : "connected");
  }

  private setStatus(status: SyncStatus): void {
    if (this.current === status) return;
    this.current = status;
    this.deps.onStatus(status);
  }
}
```

- [ ] **Step 4: Implement the UI glue and plugin entry (typecheck only)**

`packages/plugin/src/ui/statusBar.ts`:
```ts
import { statusLabel } from "../session/messages";
import type { SyncStatus } from "../session/status";

export class StatusBar {
  constructor(private readonly el: HTMLElement) {
    el.addClass("crdt-sync-status");
    this.render("stopped");
  }

  render(status: SyncStatus): void {
    this.el.setText(`CRDT: ${statusLabel(status)}`);
  }
}
```

`packages/plugin/src/ui/massDeleteModal.ts`:
```ts
import { type App, Modal, Setting } from "obsidian";

export interface MassDeleteChoices {
  confirm(): Promise<void>;
  restore(): Promise<void>;
}

export class MassDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly paths: string[],
    private readonly choices: MassDeleteChoices,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`파일 ${this.paths.length}개가 한꺼번에 삭제되었습니다`);
    this.contentEl.createEl("p", { text: "다른 기기에도 삭제를 반영할까요, 아니면 파일을 되살릴까요?" });
    const list = this.contentEl.createEl("ul", { cls: "crdt-sync-modal-list" });
    for (const path of this.paths) list.createEl("li", { text: path });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("되살리기").onClick(() => this.choose(this.choices.restore)))
      .addButton((button) => button.setButtonText("삭제 반영").setWarning().onClick(() => this.choose(this.choices.confirm)));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private choose(action: () => Promise<void>): void {
    this.close();
    void action();
  }
}
```

`packages/plugin/src/main.ts`:
```ts
import { editorInfoField, MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { HocuspocusSyncer } from "./core/hocuspocusSyncer";
import type { SyncNotice } from "./core/notices";
import { EditorBridge } from "./editor/editorBridge";
import { openSyncDatabase } from "./obsidian/idb";
import { IdbDocPersistence } from "./obsidian/idbDocPersistence";
import { IdbStorage } from "./obsidian/idbStorage";
import { ObsidianVaultAdapter } from "./obsidian/vaultAdapter";
import { noticeMessage } from "./session/messages";
import { type SessionStorage, SyncSession } from "./session/syncSession";
import { CrdtSyncSettingTab } from "./settings/settingTab";
import { DEFAULT_SETTINGS, mergeSettings, type PluginSettings, resolveSessionConfig, type SessionConfig, userColor } from "./settings/settings";
import { MassDeleteModal } from "./ui/massDeleteModal";
import { StatusBar } from "./ui/statusBar";

export default class CrdtSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private session: SyncSession | null = null;
  private statusBar: StatusBar | null = null;
  private bridge: EditorBridge | null = null;
  private restarting: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.bridge = new EditorBridge({
      getSource: () => this.session?.editorSource ?? null,
      getUser: () => ({ name: this.settings.deviceName, ...userColor(this.settings.deviceName) }),
      fileOf: (state) => state.field(editorInfoField, false)?.file?.path ?? null,
      saveEditor: (view, path) => this.saveEditor(view, path),
    });
    this.registerEditorExtension(this.bridge.extension());
    this.addSettingTab(new CrdtSyncSettingTab(this.app, this));
    this.addCommand({ id: "reconnect", name: "다시 연결", callback: () => void this.restartSession() });
    this.addCommand({ id: "pause", name: "동기화 일시정지", callback: () => this.session?.pause() });
    this.addCommand({ id: "resume", name: "동기화 재개", callback: () => this.session?.resume() });
    // Mobile apps suspend sockets in the background; reconnect as soon as the app is visible or online again.
    this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.session?.resume());
    this.registerDomEvent(window, "online", () => this.session?.resume());
    this.app.workspace.onLayoutReady(() => void this.restartSession());
  }

  async onunload(): Promise<void> {
    await this.stopSession();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  restartSession(): Promise<void> {
    this.restarting = this.restarting.then(() => this.restart());
    return this.restarting;
  }

  private async restart(): Promise<void> {
    await this.stopSession();
    if (!this.settings.enabled) return this.statusBar?.render("stopped");
    const result = resolveSessionConfig(this.settings, (id) => this.app.secretStorage.getSecret(id));
    if (!result.ok) {
      this.statusBar?.render("error");
      new Notice(`CRDT Sync 설정을 확인하세요:\n${result.problems.join("\n")}`);
      return;
    }
    this.session = this.createSession(result.config);
    try {
      await this.session.start();
    } catch (error) {
      this.statusBar?.render("error");
      new Notice(`CRDT Sync를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.bridge?.refreshAll();
  }

  private createSession(config: SessionConfig): SyncSession {
    const session: SyncSession = new SyncSession({
      config,
      vault: new ObsidianVaultAdapter(this.app.vault),
      openStorage: (cfg) => this.openStorage(cfg),
      createSyncer: (cfg, handlers) => new HocuspocusSyncer({ url: cfg.serverUrl, token: cfg.token, ...handlers }),
      isOpenInEditor: (path) => this.bridge?.isOpen(path) ?? false,
      excludedPrefixes: [`${this.app.vault.configDir}/`],
      onStatus: (status) => this.statusBar?.render(status),
      onNotice: (notice) => this.showNotice(notice, session),
    });
    return session;
  }

  private async openStorage(config: SessionConfig): Promise<SessionStorage> {
    const db = await openSyncDatabase(`crdt-sync/${this.app.vault.getName()}/${config.vaultId}`, indexedDB);
    const persistence = new IdbDocPersistence(db, { onError: (error) => console.error("CRDT Sync: saving local state failed", error) });
    return { storage: new IdbStorage(db), persistence, flush: () => persistence.flushAll(), close: () => db.close() };
  }

  private showNotice(notice: SyncNotice, session: SyncSession): void {
    if (this.settings.debugLogging) console.debug("CRDT Sync notice", notice.kind);
    new Notice(noticeMessage(notice));
    if (notice.kind !== "mass-delete-paused") return;
    new MassDeleteModal(this.app, notice.paths, { confirm: () => session.confirmDeletes(), restore: () => session.restoreDeletes() }).open();
  }

  private async stopSession(): Promise<void> {
    await this.bridge?.detachAll(); // needs the running engine for capture/notify
    const session = this.session;
    this.session = null;
    await session?.stop();
  }

  private async saveEditor(view: EditorView, path: string): Promise<void> {
    const info = view.state.field(editorInfoField, false);
    if (info instanceof MarkdownView && info.file?.path === path) await info.save();
  }
}
```

> `new ObsidianVaultAdapter(this.app.vault)` relies on `Vault` satisfying `ObsidianVaultLike` structurally. If TypeScript rejects it (overload or parameter-type mismatch), add a typed helper `asVaultLike(vault: Vault): ObsidianVaultLike` in `src/obsidian/vaultAdapter.ts` that returns an object delegating each of the ten methods to `vault`, and use it here — no `as unknown as` casts.

- [ ] **Step 5: Run tests, typecheck and the bundle test**

Run: `npx vitest run packages/plugin/test/syncSession.test.ts packages/plugin/test/bundle.test.ts && npm run check`
Expected: PASS; full suite green; the bundle still imports only `obsidian`, `@codemirror/state`, `@codemirror/view`.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin
git commit -m "feat(plugin): sync session, plugin lifecycle, status bar and mass-delete modal"
```

---

### Task 10: Dev install script, README and manual verification checklist

**Files:**
- Create: `packages/plugin/scripts/install-dev.mjs`, `docs/manual-verification.md`, `README.md`
- Test: `packages/plugin/test/installDev.test.ts`

**Interfaces:**
- Consumes: `packages/plugin/dist/*` (Task 3 build).
- Produces: `npm run install-dev -w @obsidian-crdt/plugin -- <vault path>` copies `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/crdt-sync/` (respecting `--config-dir <name>`).

- [ ] **Step 1: Write the failing test**

`packages/plugin/test/installDev.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/plugin/test/installDev.test.ts`
Expected: FAIL — script not found.

- [ ] **Step 3: Implement the script**

`packages/plugin/scripts/install-dev.mjs`:
```js
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const PLUGIN_ID = "crdt-sync";
const FILES = ["main.js", "manifest.json", "styles.css"];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
}

const vaultArg = process.argv[2];
if (!vaultArg || vaultArg.startsWith("--")) {
  console.error("usage: npm run install-dev -- <vault path> [--config-dir .obsidian] [--dist dist]");
  process.exit(2);
}
const vault = resolve(vaultArg);
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
```

- [ ] **Step 4: Write the docs**

`README.md`:
````markdown
# Obsidian CRDT Sync

Obsidian 노트를 여러 기기에서 충돌 없이 실시간으로 함께 편집하는 플러그인입니다 (Yjs + Hocuspocus).

- 설계: [docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md](docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md)
- 서버 배포: [deploy/README.md](deploy/README.md)
- 실제 Obsidian 검증 목록: [docs/manual-verification.md](docs/manual-verification.md)

## 개발

```bash
npm install
npm run check
npm run build -w @obsidian-crdt/plugin
npm run install-dev -w @obsidian-crdt/plugin -- "/path/to/test vault"
```

설치 후 Obsidian에서 커뮤니티 플러그인 → CRDT Sync를 켜고 설정에서 서버 주소, 볼트 ID, 토큰을 입력합니다.
토큰은 Obsidian 비밀 저장소에 보관되며 `data.json`에는 들어가지 않습니다.

## 운영 가이드 (스펙 §8)

- 플러그인을 쓰는 모든 기기에서 **Obsidian Git의 auto-pull을 끈다.**
- git 커밋과 push는 **커밋 기기 한 대**에서만 한다.
- git 충돌이 나면 **작업 트리(CRDT) 버전을 우선**한다.
- 2MB가 넘는 `.md`, `.obsidian/`, `.trash/`, `.git/`은 동기화하지 않는다. 첨부파일(이미지, PDF)은 아직 동기화하지 않는다.
- 한꺼번에 많은 파일이 지워지면 동기화가 멈추고 확인 창이 뜬다.
````

`docs/manual-verification.md`:
````markdown
# 실제 Obsidian 검증 목록

자동 테스트로 확인할 수 없는 항목입니다 (스펙 §9). 두 기기(또는 두 볼트 창)에 같은 서버, 같은 볼트 ID로 플러그인을 설치하고, 설정에서 **디버그 로그**를 켠 뒤 진행합니다.
각 항목에 결과(통과 / 실패 + 관찰 내용)를 적고, 실패하면 스펙 §9의 대안을 적용합니다.

## 1. 편집기
- [ ] 두 기기에서 같은 노트를 열고 동시에 타이핑 → 양쪽 내용이 같고, 상대 커서와 기기 이름이 보인다.
- [ ] 한 노트를 연 상태에서 다른 노트로 전환(같은 탭) → 이전 노트 내용이 바뀌지 않는다. (§9 CM6 재사용 위험)
- [ ] 노트를 연 상태에서 다른 프로그램으로 그 파일을 수정 → Obsidian이 편집기를 다시 불러올 때 다른 기기의 동시 편집이 사라지지 않는다. (§9 편집기 재로딩 위험)
- [ ] Cmd/Ctrl+Z가 내 입력만 되돌린다 (상대 입력은 남는다).
- [ ] 노트를 빠르게 타이핑하다 곧바로 탭을 닫는다 → 닫은 뒤 다른 기기에서 수정해도 텍스트가 두 번 들어가지 않는다. (닫기 순서)
- [ ] 같은 노트를 두 창에 열고 하나만 닫는다 → 남은 창에서 계속 실시간 동기화된다.

## 2. 파일 작업
- [ ] 새 노트를 만들고 바로 타이핑 → 다른 기기에 생기고 내용이 맞다.
- [ ] 연쇄 이름 변경 `a→b` 직후 `c→a`, 이름 맞바꾸기, 폴더 이동 → 두 기기의 경로와 내용이 같고 conflict 파일이 생기지 않는다. (§9 echo 위험)
- [ ] 폴더 이름 변경과 폴더 삭제 → 안의 노트가 다른 기기에서도 옮겨지거나 휴지통으로 간다. (Obsidian이 폴더 안 파일마다 이벤트를 보내는지 기록)
- [ ] macOS/iOS에서 `Note.md`와 `note.md`처럼 대소문자만 다른 이름 → 한쪽이 conflict 이름으로 바뀌고 덮어쓰기가 없다. (§9 대소문자 위험)
- [ ] 노트 10개 이상을 한꺼번에 삭제 → 확인 창이 뜨고, "되살리기"와 "삭제 반영"이 각각 맞게 동작한다.

## 3. 연결과 모바일
- [ ] 비행기 모드에서 편집 → 다시 연결하면 양쪽이 합쳐진다.
- [ ] iOS/Android에서 앱을 백그라운드로 보냈다 돌아온다 → 상태 표시줄이 곧 "동기화됨"으로 돌아온다.
- [ ] 잘못된 토큰 → "인증 실패" 상태가 되고 재시도하지 않는다. 올바른 토큰으로 바꾸고 "적용하고 다시 연결" → 정상 동작.
- [ ] 큰 볼트(노트 수천 개)를 iOS에서 처음 동기화 → 걸린 시간, 메모리, IndexedDB 사용량을 기록한다. (§9 모바일 용량 위험)

## 4. git 흐름
- [ ] 폰에서 수정 → 데스크톱이 꺼져 있다가 켜진다 → 데스크톱 디스크에 반영되고 커밋 기기에서 git 커밋에 포함된다.
````

Update the spec so it matches what was built (`docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md`):
- §3.2 `DocManager` row: replace "IndexedDB 영속화(y-indexeddb)" with "볼트당 IndexedDB 하나(`records`/`flags`/`docs` 스토어)에 Y.Doc 상태를 디바운스 저장 — y-indexeddb는 문서마다 DB를 만들어 노트 수천 개에서 부적합".
- §6 "토큰 저장" bullet: replace the fallback sentence with "Obsidian 1.11.4+의 `app.secretStorage`에 저장하고, `data.json`에는 비밀 ID만 둔다. 최소 지원 버전은 1.11.4."
- §11 A4: set the minimum version to 1.11.4.

- [ ] **Step 5: Run tests and the whole suite**

Run: `npx vitest run packages/plugin/test/installDev.test.ts && npm run check && npm run build -w @obsidian-crdt/plugin`
Expected: PASS; full suite green; `packages/plugin/dist/main.js` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin README.md docs/manual-verification.md docs/superpowers/specs
git commit -m "docs: add dev install script, README and manual verification checklist"
```
