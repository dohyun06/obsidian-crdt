import type { DatabaseSync } from "node:sqlite";

export class DocumentStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  load(name: string): Uint8Array | null {
    const row = this.db.prepare("SELECT data FROM documents WHERE name = ?").get(name) as { data: Uint8Array } | undefined;
    return row ? row.data : null;
  }

  save(name: string, state: Uint8Array): void {
    this.db
      .prepare(
        `INSERT INTO documents (name, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(name, state, this.now());
  }
}
