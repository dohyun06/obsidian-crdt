/** Runs async tasks strictly one after another. A failing task is reported and does not stop the queue. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(task: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const run = this.tail
      .then(task)
      .catch((error: unknown) => this.onError(error))
      .finally(() => {
        this.pending -= 1;
      });
    this.tail = run;
    return run;
  }

  get isIdle(): boolean {
    return this.pending === 0;
  }
}

export class KeyedDebouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(key: string, delayMs: number, action: () => void): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        action();
      }, delayMs),
    );
  }

  cancel(key: string): void {
    const existing = this.timers.get(key);
    if (existing === undefined) return;
    clearTimeout(existing);
    this.timers.delete(key);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}

const DEFAULT_POLL_MS = 5;

export async function waitUntil(predicate: () => boolean, pollMs = DEFAULT_POLL_MS): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
