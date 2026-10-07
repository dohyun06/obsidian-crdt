import { foldPathCase } from "@obsidian-crdt/shared";
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

type Handler = (file: ObsidianFileLike, oldPath: string) => unknown;

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** Behaves like Obsidian's Vault where the adapter depends on it: async events, strict create/createFolder. */
export class FakeObsidianVault implements ObsidianVaultLike {
  /** Keyed by key(path); each file keeps the spelling it was stored with. */
  readonly files = new Map<string, FakeFile>();
  readonly folders = new Set<string>();
  readonly trashed: Array<{ path: string; system: boolean }> = [];
  private readonly handlers = new Map<string, Set<Handler>>();

  /** Map key for a path; a case-sensitive file system uses the path itself. */
  protected key(path: string): string {
    return path;
  }

  seed(path: string, data: string): void {
    for (let parent = parentOf(path); parent; parent = parentOf(parent)) this.folders.add(this.key(parent));
    this.files.set(this.key(path), new FakeFile(path, data));
  }

  /** The stored file at `path` (compared like the file system compares names). */
  fileAt(path: string): FakeFile | undefined {
    return this.files.get(this.key(path));
  }

  getMarkdownFiles(): ObsidianFileLike[] {
    return [...this.files.values()].filter((file) => file.extension === "md");
  }

  getAbstractFileByPath(path: string): ObsidianFileLike | null {
    return this.files.get(this.key(path)) ?? (this.folders.has(this.key(path)) ? new FakeFolder(path) : null);
  }

  async read(file: ObsidianFileLike): Promise<string> {
    return (file as FakeFile).data;
  }

  async create(path: string, data: string): Promise<ObsidianFileLike> {
    if (this.getAbstractFileByPath(path)) throw new Error("File already exists.");
    if (parentOf(path) && !this.folders.has(this.key(parentOf(path)))) throw new Error("Parent folder does not exist.");
    const file = new FakeFile(path, data);
    this.files.set(this.key(path), file);
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
    const oldPath = file.path;
    const caseOnly = this.key(oldPath) === this.key(newPath) && oldPath !== newPath;
    if (!caseOnly && this.getAbstractFileByPath(newPath)) throw new Error("Destination file already exists!");
    if (this.folders.has(this.key(oldPath))) return this.renameFolder(oldPath, newPath);
    const target = this.files.get(this.key(oldPath))!;
    this.files.delete(this.key(oldPath));
    target.path = newPath;
    this.files.set(this.key(newPath), target);
    this.emit("rename", target, oldPath);
  }

  async trash(file: ObsidianFileLike, system: boolean): Promise<void> {
    this.files.delete(this.key(file.path));
    this.trashed.push({ path: file.path, system });
    this.emit("delete", file);
  }

  async createFolder(path: string): Promise<ObsidianFileLike> {
    if (this.getAbstractFileByPath(path)) throw new Error("Folder already exists.");
    if (parentOf(path) && !this.folders.has(this.key(parentOf(path)))) throw new Error("Parent folder does not exist.");
    this.folders.add(this.key(path));
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
    const file = this.files.get(this.key(path))!;
    file.data = data;
    this.emit("modify", file);
  }

  private renameFolder(oldPath: string, newPath: string): void {
    this.folders.delete(this.key(oldPath));
    this.folders.add(this.key(newPath));
    for (const file of [...this.files.values()].filter((entry) => this.key(entry.path).startsWith(this.key(`${oldPath}/`)))) {
      this.files.delete(this.key(file.path));
      file.path = `${newPath}${file.path.slice(oldPath.length)}`;
      this.files.set(this.key(file.path), file);
    }
    this.emit("rename", new FakeFolder(newPath), oldPath); // only the folder event, like the worst case
  }

  private emit(name: string, file: ObsidianFileLike, oldPath = ""): void {
    queueMicrotask(() => {
      for (const handler of this.handlers.get(name) ?? []) handler(file, oldPath);
    });
  }
}

/** Case-insensitive like APFS (macOS/iOS default): names compare folded, the stored spelling is kept. */
export class CaseFoldingObsidianVault extends FakeObsidianVault {
  protected override key(path: string): string {
    return foldPathCase(path);
  }
}
