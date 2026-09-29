import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Single-process adapter. Enforce one writer per issuer and store. */
export class FileStore {
    path;
    data;
    constructor(path, data) {
        this.path = path;
        this.data = data;
    }
    static async open(path) {
        try {
            const data = JSON.parse(await readFile(path, 'utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data))
                throw new Error('Invalid store');
            return new FileStore(path, data);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            return new FileStore(path, {});
        }
    }
    async get(key) { return structuredClone(this.data[key]); }
    async put(key, value) {
        const next = { ...this.data, [key]: structuredClone(value) };
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.tmp`;
        const file = await open(temp, 'w', 0o600);
        try {
            await file.writeFile(JSON.stringify(next, null, 2));
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(temp, this.path);
        const dir = await open(dirname(this.path), 'r');
        try {
            await dir.sync();
        }
        finally {
            await dir.close();
        }
        Object.assign(this.data, next);
    }
}
export class SerialQueue {
    tail = Promise.resolve();
    run(fn) {
        const result = this.tail.then(fn);
        this.tail = result.catch(() => undefined);
        return result;
    }
}
