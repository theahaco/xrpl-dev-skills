import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
/** Single-writer filesystem adapter. Files can contain signed transactions and demo keys. */
export class FileStore {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    path(key) {
        if (!/^[a-zA-Z0-9_-]+$/.test(key))
            throw new Error('Invalid storage key');
        return join(this.directory, `${key}.json`);
    }
    async get(key) {
        try {
            return JSON.parse(await readFile(this.path(key), 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw error;
        }
    }
    async put(key, value) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = this.path(key);
        const file = await open(`${path}.tmp`, 'w', 0o600);
        try {
            await file.writeFile(JSON.stringify(value, null, 2));
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(`${path}.tmp`, path);
        const dir = await open(this.directory, 'r');
        try {
            await dir.sync();
        }
        finally {
            await dir.close();
        }
    }
}
