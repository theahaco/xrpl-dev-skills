import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** One durable store and exclusive process per issuer. Never remove a live lock. */
export class Store {
    db;
    lock;
    constructor(path) {
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
        }
        catch (e) {
            rmdirSync(this.lock);
            throw e;
        }
    }
    getTx(id) {
        return this.db.prepare('SELECT intent,blob,hash,sequence,lastLedger,receipt FROM tx WHERE id=?').get(id);
    }
    pendingId() {
        return this.db.prepare('SELECT id FROM tx WHERE receipt IS NULL LIMIT 1').get()?.['id'];
    }
    prepare(id, p) {
        this.db.prepare('INSERT INTO tx VALUES (?,?,?,?,?,?,NULL)').run(id, p.intent, p.blob, p.hash, p.sequence, p.lastLedger);
    }
    finish(id, r) { this.db.prepare('UPDATE tx SET receipt=? WHERE id=?').run(JSON.stringify(r), id); }
    ban(issuance, holder, reason) {
        this.db.prepare('INSERT OR IGNORE INTO bans VALUES (?,?,?)').run(issuance, holder, reason);
    }
    isBanned(issuance, holder) {
        return !!this.db.prepare('SELECT 1 FROM bans WHERE issuance=? AND holder=?').get(issuance, holder);
    }
    get(key) {
        const r = this.db.prepare('SELECT value FROM values_store WHERE key=?').get(key);
        return r ? JSON.parse(String(r['value'])) : undefined;
    }
    set(key, value) {
        this.db.prepare('INSERT INTO values_store VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    }
    audit() { return this.db.prepare('SELECT id,intent,hash,sequence,lastLedger,receipt FROM tx ORDER BY rowid').all(); }
    close() { this.db.close(); rmdirSync(this.lock); }
}
