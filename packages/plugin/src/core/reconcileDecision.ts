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
    // Spec §4.3/§4.5: the server text wins even when it is still "" — the creating device may have published the
    // index entry before its text, and taking the disk text here would double it once that text arrives.
    if (disk === "") return { kind: "write-disk", text: current };
    return { kind: "conflict", keep: current, diskCopy: disk };
  }
  if (disk === base) return { kind: "write-disk", text: current };
  if (current === base) return { kind: "merge", text: disk };
  const merged = mergeThreeWay(base, disk, current);
  return merged.ok ? { kind: "merge", text: merged.text } : { kind: "conflict", keep: current, diskCopy: disk };
}
