import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
export function errorCode(error) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    if ('code' in error && typeof error.code === 'string')
        return error.code;
    if ('data' in error && typeof error.data === 'object' && error.data !== null &&
        'error' in error.data && typeof error.data.error === 'string')
        return error.data.error;
    return undefined;
}
export async function atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try {
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
        await file.sync();
    }
    finally {
        await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
/** Single-host reference adapter. A stale lock requires operator reconciliation, never auto-removal. */
export class FileStore {
    path;
    values;
    constructor(path, values) {
        this.path = path;
        this.values = values;
    }
    static async open(path) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const lock = await open(`${path}.lock`, 'wx', 0o600);
        await lock.writeFile(String(process.pid));
        await lock.close();
        try {
            let values = {};
            try {
                values = JSON.parse(await readFile(path, 'utf8'));
            }
            catch (error) {
                if (errorCode(error) !== 'ENOENT')
                    throw error;
            }
            if (typeof values !== 'object' || values === null || Array.isArray(values))
                throw new Error('Invalid store');
            return new FileStore(path, values);
        }
        catch (error) {
            await unlink(`${path}.lock`);
            throw error;
        }
    }
    async get(key) {
        return structuredClone(this.values[key]);
    }
    async set(key, value) {
        const next = { ...this.values, [key]: structuredClone(value) };
        await atomicJson(this.path, next);
        this.values[key] = structuredClone(value);
    }
    async close() { await unlink(`${this.path}.lock`); }
}
//# sourceMappingURL=store.js.map