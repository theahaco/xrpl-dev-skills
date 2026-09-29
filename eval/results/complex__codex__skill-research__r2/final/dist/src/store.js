import { closeSync, openSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
/** Durable single-writer store. Keep this database across deployments and retries. */
export class Store {
    db;
    lock;
    constructor(path) {
        this.lock = `${path}.lockfile`;
        // Fail closed on a second process or a crash; an operator must reconcile before removing a stale lock.
        const fd = openSync(this.lock, 'wx', 0o600);
        closeSync(fd);
        try {
            this.db = new DatabaseSync(path);
            this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        }
        catch (error) {
            unlinkSync(this.lock);
            throw error;
        }
    }
    get(key) {
        const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
        return row ? JSON.parse(String(row.value)) : undefined;
    }
    put(key, value) {
        this.db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    }
    entries(prefix) {
        return this.db.prepare('SELECT key, value FROM state ORDER BY key').all().filter(row => String(row.key).startsWith(prefix)).map(row => ({ key: String(row.key), value: JSON.parse(String(row.value)) }));
    }
    atomic(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            fn();
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    close() { this.db.close(); unlinkSync(this.lock); }
}
