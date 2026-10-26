export type SyncStatus =
  | "stopped"
  | "starting"
  | "waiting-first-sync"
  | "connected"
  | "offline"
  | "auth-failed"
  | "deletes-paused"
  | "error";
