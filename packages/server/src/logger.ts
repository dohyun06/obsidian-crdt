export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

/** Never pass tokens or note contents in `fields`. */
export function createJsonLogger(write: (line: string) => void, now: () => Date = () => new Date()): Logger {
  return {
    log(level, event, fields = {}) {
      write(JSON.stringify({ ...fields, level, event, time: now().toISOString() }));
    },
  };
}
