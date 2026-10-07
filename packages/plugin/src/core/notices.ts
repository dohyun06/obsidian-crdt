/** User-facing events. Plan 2 turns them into Obsidian notices and status bar text. */
export type SyncNotice =
  | { kind: "waiting-for-first-sync" }
  | { kind: "conflict-copy"; path: string; copyPath: string }
  | { kind: "file-too-large"; path: string }
  | { kind: "mass-delete-paused"; paths: string[] }
  | { kind: "task-failed"; message: string };
