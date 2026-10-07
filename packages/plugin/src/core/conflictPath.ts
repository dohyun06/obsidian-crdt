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
