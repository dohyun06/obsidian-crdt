export const TEXT_HISTORY_LIMIT = 32;
/** Cap on the remembered text per file; sizes count UTF-16 code units x 2 (bytes held in memory). */
export const TEXT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const BYTES_PER_CODE_UNIT = 2;

/**
 * Recent Y.Text states of files shown in an editor. The editor's autosave writes one of these states to disk,
 * possibly after newer remote edits arrived; a disk text found here carries nothing new (spec §9 fallback).
 * Trade-off: an outside revert of the file to exactly a recently recorded state is treated as such a lagging
 * save and not as a new edit.
 */
export class TextHistory {
  private readonly byFile = new Map<string, string[]>();

  record(fileId: string, text: string): void {
    const list = this.byFile.get(fileId) ?? [];
    if (list[list.length - 1] === text) return;
    list.push(text);
    let bytes = list.reduce((sum, entry) => sum + entry.length * BYTES_PER_CODE_UNIT, 0);
    // Always keep the newest entry, even if it alone exceeds the cap.
    while (list.length > 1 && (list.length > TEXT_HISTORY_LIMIT || bytes > TEXT_HISTORY_MAX_BYTES)) {
      bytes -= (list.shift() as string).length * BYTES_PER_CODE_UNIT;
    }
    this.byFile.set(fileId, list);
  }

  has(fileId: string, text: string): boolean {
    return this.byFile.get(fileId)?.includes(text) ?? false;
  }

  forget(fileId: string): void {
    this.byFile.delete(fileId);
  }
}
