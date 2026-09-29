import { open, readFile, mkdir } from 'node:fs/promises';
/** Local single-process adapter. Backend deployments should use a transactional database. */
export class FileStore {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    async append(file, value) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const f = await open(`${this.directory}/${file}`, 'a', 0o600);
        try {
            await f.writeFile(JSON.stringify(value) + '\n');
            await f.sync();
        }
        finally {
            await f.close();
        }
    }
    async records(file) {
        try {
            return (await readFile(`${this.directory}/${file}`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return [];
            throw e;
        }
    }
    async assertNoPending() {
        const entries = await this.records('transactions.jsonl');
        const pending = new Set();
        for (const e of entries) {
            if (e.kind === 'prepared')
                pending.add(String(e.hash));
            else
                pending.delete(String(e.hash));
        }
        if (pending.size)
            throw new Error(`Reconcile pending transaction hashes before rerun: ${[...pending].join(', ')}`);
    }
    prepared(hash, blob, lastLedger) { return this.append('transactions.jsonl', { kind: 'prepared', hash, blob, lastLedger }); }
    validated(receipt) { return this.append('transactions.jsonl', { kind: 'validated', ...receipt }); }
    async has(issuanceId, holder) { return (await this.records('bans.jsonl')).some(e => e.issuanceId === issuanceId && e.holder === holder); }
    async add(issuanceId, holder) { if (!(await this.has(issuanceId, holder)))
        await this.append('bans.jsonl', { issuanceId, holder }); }
}
