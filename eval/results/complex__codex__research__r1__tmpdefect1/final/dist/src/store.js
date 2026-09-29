import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
export function atomicJson(path, value) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
        writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(temporary, path);
    const dir = openSync(dirname(path), 'r');
    try {
        fsyncSync(dir);
    }
    finally {
        closeSync(dir);
    }
}
/** Single-writer durable JSON storage. Use one directory for every operation on an issuer.
 * A stale lock requires operator reconciliation; it is never silently stolen. */
export class FileStore {
    directory;
    lock;
    closed = false;
    constructor(directory) {
        this.directory = resolve(directory);
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.lock = join(this.directory, 'writer.lock');
        const fd = openSync(this.lock, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    read(name) {
        const path = this.path(name);
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    }
    write(name, value) { atomicJson(this.path(name), value); }
    path(name) {
        if (this.closed)
            throw new Error('Store is closed');
        if (!/^[a-zA-Z0-9_-]+$/.test(name))
            throw new Error('Invalid store key');
        return join(this.directory, `${name}.json`);
    }
    close() { if (!this.closed) {
        unlinkSync(this.lock);
        this.closed = true;
    } }
}
export class SerialQueue {
    tail = Promise.resolve();
    run(work) {
        const result = this.tail.then(work);
        this.tail = result.catch(() => undefined);
        return result;
    }
}
