import { mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
/** Atomic replacement plus fsync; single writer only. Keep this directory backed up. */
export function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
        writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
    const dir = openSync(dirname(path), 'r');
    try {
        fsyncSync(dir);
    }
    finally {
        closeSync(dir);
    }
}
export function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
/** Append-only policy: intentionally no unban method. Corrupt state fails closed. */
export class FileBanStore {
    path;
    constructor(path) {
        this.path = path;
    }
    read() {
        if (!existsSync(this.path))
            return [];
        const value = readJson(this.path);
        if (!Array.isArray(value) || !value.every(x => typeof x === 'string'))
            throw new Error('Corrupt ban store');
        return value;
    }
    async has(id, holder) { return this.read().includes(`${id}:${holder}`); }
    async add(id, holder) {
        writeJson(this.path, [...new Set([...this.read(), `${id}:${holder}`])]);
    }
}
