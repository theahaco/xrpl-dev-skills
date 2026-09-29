import { closeSync, openSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Durable single-writer store. Keep this database across deployments and retries. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: string;
  constructor(path: string) {
    this.lock = `${path}.lockfile`;
    // Fail closed on a second process or a crash; an operator must reconcile before removing a stale lock.
    const fd = openSync(this.lock, 'wx', 0o600);
    closeSync(fd);
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  put(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  entries(prefix: string): Array<{ key: string; value: unknown }> {
    return this.db.prepare('SELECT key, value FROM state ORDER BY key').all().filter(row => String(row.key).startsWith(prefix)).map(row => ({ key: String(row.key), value: JSON.parse(String(row.value)) as unknown }));
  }
  atomic(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); unlinkSync(this.lock); }
}
