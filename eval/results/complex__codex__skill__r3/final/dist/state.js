import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
/** Single-host, single-writer store. A stale lock requires operator reconciliation, never automatic deletion. */
export class FileState {
    directory;
    data;
    constructor(directory, data) {
        this.directory = directory;
        this.data = data;
    }
    static async open(directory) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const lock = await open(join(directory, 'writer.lock'), 'wx', 0o600);
        await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        await lock.close();
        try {
            let data;
            try {
                data = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
                if (data.version !== 1 || !data.transactions || !data.bans)
                    throw new Error('Invalid state file');
            }
            catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                    throw error;
                data = { version: 1, transactions: {}, bans: {} };
            }
            return new FileState(directory, data);
        }
        catch (error) {
            await unlink(join(directory, 'writer.lock'));
            throw error;
        }
    }
    async save() {
        const file = await open(join(this.directory, 'state.tmp'), 'w', 0o600);
        try {
            await file.writeFile(JSON.stringify(this.data, null, 2));
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(join(this.directory, 'state.tmp'), join(this.directory, 'state.json'));
        const directory = await open(this.directory, 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    async close() { await unlink(join(this.directory, 'writer.lock')); }
}
export class SerialQueue {
    tail = Promise.resolve();
    run(operation) {
        const next = this.tail.then(operation);
        this.tail = next.catch(() => undefined);
        return next;
    }
}
