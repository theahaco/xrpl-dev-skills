import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Receipt { hash: string; ledger: number; code: string; sequence: number }
export interface Pending { intent: string; blob: string; hash: string; sequence: number; lastLedger: number; receipt: string | null }

/** One durable store and exclusive process per issuer. Never remove a live lock. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lock = `${path}.lock`;
    mkdirSync(this.lock, { mode: 0o700 });
    try {
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS tx (id TEXT PRIMARY KEY, intent TEXT NOT NULL, blob TEXT NOT NULL,
          hash TEXT NOT NULL, sequence INTEGER NOT NULL, lastLedger INTEGER NOT NULL, receipt TEXT);
        CREATE TABLE IF NOT EXISTS bans (issuance TEXT NOT NULL, holder TEXT NOT NULL, reason TEXT NOT NULL,
          PRIMARY KEY(issuance, holder));
        CREATE TABLE IF NOT EXISTS values_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    } catch (e) { rmdirSync(this.lock); throw e; }
  }
  getTx(id: string): Pending | undefined {
    return this.db.prepare('SELECT intent,blob,hash,sequence,lastLedger,receipt FROM tx WHERE id=?').get(id) as unknown as Pending | undefined;
  }
  pendingId(): string | undefined {
    return this.db.prepare('SELECT id FROM tx WHERE receipt IS NULL LIMIT 1').get()?.['id'] as string | undefined;
  }
  prepare(id: string, p: Omit<Pending, 'receipt'>): void {
    this.db.prepare('INSERT INTO tx VALUES (?,?,?,?,?,?,NULL)').run(id,p.intent,p.blob,p.hash,p.sequence,p.lastLedger);
  }
  finish(id: string, r: Receipt): void { this.db.prepare('UPDATE tx SET receipt=? WHERE id=?').run(JSON.stringify(r),id); }
  ban(issuance: string, holder: string, reason: string): void {
    this.db.prepare('INSERT OR IGNORE INTO bans VALUES (?,?,?)').run(issuance,holder,reason);
  }
  isBanned(issuance: string, holder: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bans WHERE issuance=? AND holder=?').get(issuance,holder);
  }
  get<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM values_store WHERE key=?').get(key);
    return r ? JSON.parse(String(r['value'])) as T : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO values_store VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  }
  audit(): unknown[] { return this.db.prepare('SELECT id,intent,hash,sequence,lastLedger,receipt FROM tx ORDER BY rowid').all(); }
  close(): void { this.db.close(); rmdirSync(this.lock); }
}
