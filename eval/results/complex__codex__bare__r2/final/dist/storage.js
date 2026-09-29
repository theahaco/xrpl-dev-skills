import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** Local durable adapter. Deploy on persistent disk, one issuer worker per database. */
export class SqliteStore {
    db;
    constructor(path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        chmodSync(path, 0o600);
        this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bans (issuance TEXT, holder TEXT, PRIMARY KEY(issuance, holder));
      CREATE TABLE IF NOT EXISTS transactions (hash TEXT PRIMARY KEY, prepared TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    }
    assertNoPending() {
        const pending = this.db.prepare('SELECT hash FROM transactions WHERE receipt IS NULL').all();
        if (pending.length)
            throw new Error(`Reconcile pending transactions before restarting: ${JSON.stringify(pending)}`);
    }
    async has(id, holder) {
        return !!this.db.prepare('SELECT 1 FROM bans WHERE issuance=? AND holder=?').get(id, holder);
    }
    async add(id, holder) {
        this.db.prepare('INSERT OR IGNORE INTO bans VALUES (?,?)').run(id, holder);
    }
    async prepared(record) {
        this.db.prepare('INSERT INTO transactions(hash,prepared) VALUES (?,?)').run(record.hash, JSON.stringify(record));
    }
    async validated(receipt) {
        this.db.prepare('UPDATE transactions SET receipt=? WHERE hash=?').run(JSON.stringify(receipt), receipt.hash);
        console.log(`${receipt.code} ${receipt.hash}`);
    }
    get(key) {
        const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
        return row ? JSON.parse(String(row.value)) : undefined;
    }
    put(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(key, JSON.stringify(value));
    }
    receipts() {
        return this.db.prepare('SELECT prepared,receipt FROM transactions').all().map(row => ({
            transaction: JSON.parse(String(row.prepared)).transaction,
            receipt: row.receipt ? JSON.parse(String(row.receipt)) : null,
        }));
    }
    close() { this.db.close(); }
}
