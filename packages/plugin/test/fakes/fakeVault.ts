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

  get listenerCount(): number {
    return this.listeners.size;
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
