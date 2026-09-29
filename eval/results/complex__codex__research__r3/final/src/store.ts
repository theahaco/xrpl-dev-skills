import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Receipt { hash: string; code: string; ledger: number; issuanceId?: string }
export interface Pending { key: string; account: string; intent: string; blob: string; hash: string; receipt: string | null }

/** Durable single-writer journal. Keep this directory on persistent local storage. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lock = `${path}.lock`;
    const fd = openSync(this.lock, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      closeSync(openSync(path, 'a', 0o600));
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS checkpoints (name TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS transactions (
          key TEXT PRIMARY KEY, account TEXT NOT NULL, intent TEXT NOT NULL,
          blob TEXT NOT NULL, hash TEXT NOT NULL, receipt TEXT);
        CREATE TABLE IF NOT EXISTS bans (
          issuance TEXT NOT NULL, holder TEXT NOT NULL, reason TEXT NOT NULL,
          created TEXT NOT NULL, PRIMARY KEY(issuance, holder));`);
    } catch (e) { unlinkSync(this.lock); throw e; }
  }
  get(key: string): Pending | undefined {
    return this.db.prepare('SELECT * FROM transactions WHERE key=?').get(key) as Pending | undefined;
  }
  pending(account: string): Pending | undefined {
    return this.db.prepare('SELECT * FROM transactions WHERE account=? AND receipt IS NULL LIMIT 1').get(account) as Pending | undefined;
  }
  prepare(row: Omit<Pending, 'receipt'>): void {
    this.db.prepare('INSERT INTO transactions(key,account,intent,blob,hash) VALUES(?,?,?,?,?)')
      .run(row.key, row.account, row.intent, row.blob, row.hash);
  }
  complete(key: string, receipt: Receipt): void {
    this.db.prepare('UPDATE transactions SET receipt=? WHERE key=?').run(JSON.stringify(receipt), key);
  }
  ban(issuance: string, holder: string, reason: string): void {
    if (!reason.trim()) throw new Error('A ban requires an audit reason');
    this.db.prepare('INSERT OR IGNORE INTO bans VALUES(?,?,?,?)').run(issuance, holder, reason, new Date().toISOString());
  }
  isBanned(issuance: string, holder: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bans WHERE issuance=? AND holder=?').get(issuance, holder);
  }
  checkpoint(name: string): void { this.db.prepare('INSERT OR IGNORE INTO checkpoints VALUES(?)').run(name); }
  hasCheckpoint(name: string): boolean { return !!this.db.prepare('SELECT 1 FROM checkpoints WHERE name=?').get(name); }
  receipts(): (Receipt & { operationKey: string })[] {
    return this.db.prepare('SELECT key, receipt FROM transactions WHERE receipt IS NOT NULL ORDER BY rowid').all()
      .map(row => ({ ...JSON.parse(String(row.receipt)) as Receipt, operationKey: String(row.key) }));
  }
  close(): void { this.db.close(); unlinkSync(this.lock); }
}
