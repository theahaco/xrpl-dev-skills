import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Append-only, fsync'd store for ONE process. Backends should supply database adapters. */
export class FileStore {
    path;
    constructor(path) {
        this.path = path;
    }
    async append(event) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const file = await open(this.path, 'a', 0o600);
        try {
            await file.writeFile(JSON.stringify(event) + '\n');
            await file.sync();
        }
        finally {
            await file.close();
        }
    }
    async events() {
        try {
            return (await readFile(this.path, 'utf8')).split('\n').filter(Boolean).map((line) => {
                const value = JSON.parse(line);
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    throw new Error('Corrupt event log');
                return value;
            });
        }
        catch (e) {
            if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT')
                return [];
            throw e;
        }
    }
    async assertReady(account) {
        const events = await this.events();
        const settled = new Set(events.filter(e => e.type === 'settled').map(e => e.hash));
        for (const e of events) {
            const tx = e.transaction;
            if (e.type === 'prepared' && typeof tx === 'object' && tx !== null && 'Account' in tx && tx.Account === account && !settled.has(e.hash))
                throw new Error(`Unreconciled transaction ${String(e.hash)}; reconcile before new submissions`);
        }
    }
    prepared(record) { return this.append({ type: 'prepared', ...record }); }
    settled(receipt) { return this.append({ type: 'settled', ...receipt }); }
    async isBanned(issuanceId, holder) {
        return (await this.events()).some(e => e.type === 'ban' && e.issuanceId === issuanceId && e.holder === holder);
    }
    async ban(issuanceId, holder) { await this.append({ type: 'ban', issuanceId, holder }); }
}
