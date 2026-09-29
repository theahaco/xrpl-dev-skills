import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** Durable single-writer store. Route ALL issuer signing through this writer. */
export class Journal {
    db;
    lock;
    constructor(path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.lock = `${path}.lock`;
        mkdirSync(this.lock, { mode: 0o700 });
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tx (id TEXT PRIMARY KEY, intent TEXT NOT NULL, blob TEXT NOT NULL,
        hash TEXT NOT NULL, last_ledger INTEGER NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS bans (issuance TEXT NOT NULL, holder TEXT NOT NULL,
        reason TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(issuance,holder));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    }
    get(key) {
        return this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value;
    }
    set(key, value) {
        this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    }
    banned(issuance, holder) {
        return this.db.prepare('SELECT 1 FROM bans WHERE issuance=? AND holder=?').get(issuance, holder) !== undefined;
    }
    ban(issuance, holder, reason) {
        this.db.prepare('INSERT OR IGNORE INTO bans VALUES (?,?,?,?)').run(issuance, holder, reason, new Date().toISOString());
    }
    close() { this.db.close(); rmdirSync(this.lock); }
}
