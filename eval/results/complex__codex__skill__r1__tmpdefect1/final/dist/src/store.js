import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
/** Single-process durable store; the caller must hold an exclusive process lock. */
export class FileStore {
    path;
    data;
    constructor(path) {
        this.path = path;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        try {
            this.data = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            this.data = {};
        }
    }
    get(key) { return this.data[key]; }
    /** Audit export intentionally excludes signed blobs and wallet secrets. */
    receipts() {
        return Object.fromEntries(Object.entries(this.data).filter(([key]) => key.startsWith('tx:'))
            .map(([key, value]) => [key.slice(3), value.receipt])
            .filter(([, receipt]) => receipt !== undefined));
    }
    put(key, value) {
        const next = { ...this.data, [key]: value };
        const temporary = `${this.path}.tmp`;
        const fd = openSync(temporary, 'w', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(next, null, 2));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temporary, this.path);
        const directory = openSync(dirname(this.path), 'r');
        try {
            fsyncSync(directory);
        }
        finally {
            closeSync(directory);
        }
        this.data = next;
    }
}
