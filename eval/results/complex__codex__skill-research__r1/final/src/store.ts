import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** One process owns this durable journal. Never remove a lock while its owner is alive. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lock = `${path}.lock`;
    const fd = openSync(this.lock, 'wx', 0o600);
    closeSync(fd);
    try {
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  entries<T>(prefix: string): [string, T][] {
    return this.db.prepare('SELECT key,value FROM kv ORDER BY key').all()
      .filter(row => String(row.key).startsWith(prefix))
      .map(row => [String(row.key), JSON.parse(String(row.value)) as T]);
  }
  close(): void { this.db.close(); unlinkSync(this.lock); }
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
