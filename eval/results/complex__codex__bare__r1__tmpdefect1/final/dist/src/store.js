import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
/** Exclusive single-writer store. Remove a stale lock only after stopping its owner. */
export class Store {
    path;
    db;
    lock;
    constructor(path) {
        this.path = path;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.lock = openSync(`${path}.lock`, 'wx', 0o600);
        try {
            this.db = new DatabaseSync(path);
            chmodSync(path, 0o600);
            this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        }
        catch (error) {
            closeSync(this.lock);
            unlinkSync(`${path}.lock`);
            throw error;
        }
    }
    get(key) {
        const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
        return row ? JSON.parse(String(row.value)) : undefined;
    }
    set(key, value) {
        this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    }
    atomic(action) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            action();
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    close() { this.db.close(); closeSync(this.lock); unlinkSync(`${this.path}.lock`); }
}
