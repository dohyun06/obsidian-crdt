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
    if (!isFolder(file)) {
      if (isFile(file)) listener({ type: "rename", oldPath, path: file.path });
      return;
    }
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
