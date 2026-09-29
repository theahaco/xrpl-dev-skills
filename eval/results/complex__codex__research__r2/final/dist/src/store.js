import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function atomicJson(path, data) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    const file = await open(temp, 'w', 0o600);
    try {
        await file.writeFile(JSON.stringify(data, null, 2) + '\n');
        await file.sync();
    }
    finally {
        await file.close();
    }
    await rename(temp, path);
    const dir = await open(dirname(path), 'r');
    try {
        await dir.sync();
    }
    finally {
        await dir.close();
    }
}
export class FileStore {
    path;
    state;
    release;
    constructor(path, state, release) {
        this.path = path;
        this.state = state;
        this.release = release;
    }
    static async open(path) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const lockPath = `${path}.lock`;
        const lock = await open(lockPath, 'wx', 0o600);
        try {
            await lock.writeFile(String(process.pid));
            let state;
            try {
                const raw = JSON.parse(await readFile(path, 'utf8'));
                if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 ||
                    !('transactions' in raw) || !raw.transactions || !('bans' in raw) || !raw.bans) {
                    throw new Error('Invalid compliance store: refuse to reset it');
                }
                state = raw;
            }
            catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                    throw error;
                state = { version: 1, transactions: {}, bans: {} };
            }
            const store = new FileStore(path, state, async () => { await lock.close(); await unlink(lockPath); });
            await store.save();
            return store;
        }
        catch (error) {
            await lock.close();
            await unlink(lockPath);
            throw error;
        }
    }
    save() { return atomicJson(this.path, this.state); }
    close() { return this.release(); }
}
//# sourceMappingURL=store.js.map