import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BanStore, Journal, Prepared, Receipt } from './issuer.js';

/** Local durable adapter. Deploy on persistent disk, one issuer worker per database. */
export class SqliteStore implements BanStore, Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bans (issuance TEXT, holder TEXT, PRIMARY KEY(issuance, holder));
      CREATE TABLE IF NOT EXISTS transactions (hash TEXT PRIMARY KEY, prepared TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  assertNoPending(): void {
    const pending = this.db.prepare('SELECT hash FROM transactions WHERE receipt IS NULL').all();
    if (pending.length) throw new Error(`Reconcile pending transactions before restarting: ${JSON.stringify(pending)}`);
  }
  async has(id: string, holder: string): Promise<boolean> {
    return !!this.db.prepare('SELECT 1 FROM bans WHERE issuance=? AND holder=?').get(id, holder);
  }
  async add(id: string, holder: string): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO bans VALUES (?,?)').run(id, holder);
  }
  async prepared(record: Prepared): Promise<void> {
    this.db.prepare('INSERT INTO transactions(hash,prepared) VALUES (?,?)').run(record.hash, JSON.stringify(record));
  }
  async validated(receipt: Receipt): Promise<void> {
    this.db.prepare('UPDATE transactions SET receipt=? WHERE hash=?').run(JSON.stringify(receipt), receipt.hash);
    console.log(`${receipt.code} ${receipt.hash}`);
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  put(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(key, JSON.stringify(value));
  }
  receipts(): unknown[] {
    return this.db.prepare('SELECT prepared,receipt FROM transactions').all().map(row => ({
      transaction: (JSON.parse(String(row.prepared)) as Prepared).transaction,
      receipt: row.receipt ? JSON.parse(String(row.receipt)) as Receipt : null,
    }));
  }
  close(): void { this.db.close(); }
}
