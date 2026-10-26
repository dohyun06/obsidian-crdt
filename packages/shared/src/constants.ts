/** Delay before a remote text change is written to disk for a file that is not open in an editor. */
export const DISK_WRITE_DEBOUNCE_MS = 1000;
/** Delay before remote index changes (create/rename/delete) are applied to disk. */
export const INDEX_PASS_DEBOUNCE_MS = 200;
/** A delete followed by a create with identical content inside this window is a rename (e.g. `git mv`). */
export const RENAME_PAIR_WINDOW_MS = 1500;
/** Idle time after which the Y.Text of a file open in an editor is remembered as a possible autosave state. */
export const EDITOR_SNAPSHOT_DEBOUNCE_MS = 200;
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
