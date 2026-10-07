export interface MassDeleteGuardOptions {
  threshold: number;
  windowMs: number;
  now: () => number;
}

export class MassDeleteGuard {
  private timestamps: number[] = [];

  constructor(private readonly options: MassDeleteGuardOptions) {}

  /** Records `count` deletions happening now; returns true when the window reaches the threshold. */
  record(count: number): boolean {
    const now = this.options.now();
    this.timestamps = this.timestamps.filter((at) => now - at <= this.options.windowMs);
    for (let i = 0; i < count; i++) this.timestamps.push(now);
    return this.timestamps.length >= this.options.threshold;
  }

  reset(): void {
    this.timestamps = [];
  }
}
