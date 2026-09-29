import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
/** Single writer, durable local store. Keep the DB and journal with the issuer service. */
export class Store {
    db;
    lock;
    constructor(path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.lock = `${path}.lock`;
        const fd = openSync(this.lock, 'wx', 0o600);
        closeSync(fd);
        try {
            this.db = new DatabaseSync(path);
            chmodSync(path, 0o600);
            this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        }
        catch (error) {
            unlinkSync(this.lock);
            throw error;
        }
    }
    get(key) {
        const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
        return row ? JSON.parse(String(row.value)) : undefined;
    }
    put(key, value) {
        this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    }
    putMany(entries) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const [key, value] of entries)
                this.put(key, value);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    entries(prefix) {
        return this.db.prepare('SELECT key, value FROM state WHERE substr(key, 1, ?)=? ORDER BY key').all(prefix.length, prefix)
            .map(row => ({ key: String(row.key), value: JSON.parse(String(row.value)) }));
    }
    close() { this.db.close(); unlinkSync(this.lock); }
}
export class SerialQueue {
    tail = Promise.resolve();
    run(work) {
        const result = this.tail.then(work);
        this.tail = result.catch(() => undefined);
        return result;
    }
}
//# sourceMappingURL=store.js.map