import type { VaultEvent, VaultPort } from "./ports";

const SEPARATOR = "\0";

/**
 * Wraps the vault so the engine can recognise the rename/delete events caused by its own calls.
 * Those events describe changes the engine already recorded; handling them again would match paths
 * that records have since moved on from.
 */
export class EchoTrackingVault implements VaultPort {
  private readonly expected = new Map<string, number>();

  constructor(private readonly inner: VaultPort) {}

  listFiles(): Promise<string[]> {
    return this.inner.listFiles();
  }

  read(path: string): Promise<string | null> {
    return this.inner.read(path);
  }

  replace(path: string, expected: string | null, next: string): Promise<boolean> {
    return this.inner.replace(path, expected, next);
  }

  onEvent(listener: (event: VaultEvent) => void): () => void {
    return this.inner.onEvent(listener);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.tracked(["rename", oldPath, newPath].join(SEPARATOR), () => this.inner.rename(oldPath, newPath));
  }

  trash(path: string): Promise<void> {
    return this.tracked(["delete", path].join(SEPARATOR), () => this.inner.trash(path));
  }

  /** True (once per own operation) when the event is the echo of an engine rename or trash. */
  consume(event: VaultEvent): boolean {
    if (event.type === "create" || event.type === "modify") return false;
    const key = event.type === "rename" ? ["rename", event.oldPath, event.path].join(SEPARATOR) : ["delete", event.path].join(SEPARATOR);
    const count = this.expected.get(key) ?? 0;
    if (count === 0) return false;
    this.release(key);
    return true;
  }

  private async tracked(key: string, operation: () => Promise<void>): Promise<void> {
    this.expected.set(key, (this.expected.get(key) ?? 0) + 1);
    try {
      await operation();
    } catch (error) {
      this.release(key);
      throw error;
    }
  }

  private release(key: string): void {
    const count = this.expected.get(key) ?? 0;
    if (count <= 1) this.expected.delete(key);
    else this.expected.set(key, count - 1);
  }
}
