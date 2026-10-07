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
