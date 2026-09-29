import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export class InMemoryBanRegistry {
    records = new Map();
    async isBanned(address) {
        return this.records.has(address);
    }
    async get(address) {
        return this.records.get(address);
    }
    async add(record) {
        if (!this.records.has(record.address))
            this.records.set(record.address, { ...record });
    }
    async list() {
        return [...this.records.values()];
    }
}
/**
 * JSON-file-backed registry. Writes go to a temp file and are then renamed
 * over the original, so a crash never leaves a half-written file. Meant for
 * one process only; there is no cross-process locking.
 */
export class JsonFileBanRegistry {
    filePath;
    cache;
    writeChain = Promise.resolve();
    constructor(filePath) {
        this.filePath = filePath;
    }
    async isBanned(address) {
        return (await this.load()).has(address);
    }
    async get(address) {
        return (await this.load()).get(address);
    }
    async list() {
        return [...(await this.load()).values()];
    }
    async add(record) {
        const run = this.writeChain.then(async () => {
            const records = await this.load();
            if (records.has(record.address))
                return;
            records.set(record.address, { ...record });
            await this.persist(records);
        });
        // Keep the chain alive even if this write fails; the caller still sees the error.
        this.writeChain = run.catch(() => undefined);
        return run;
    }
    async load() {
        if (this.cache)
            return this.cache;
        let parsed;
        try {
            parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
        }
        catch (err) {
            if (err.code === 'ENOENT') {
                this.cache = new Map();
                return this.cache;
            }
            throw err;
        }
        if (!Array.isArray(parsed))
            throw new Error(`Ban registry ${this.filePath} is not a JSON array`);
        const records = new Map();
        for (const entry of parsed) {
            if (typeof entry?.address !== 'string')
                throw new Error(`Ban registry ${this.filePath} has a malformed entry`);
            records.set(entry.address, entry);
        }
        this.cache = records;
        return records;
    }
    async persist(records) {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify([...records.values()], null, 2) + '\n', { mode: 0o600 });
        await rename(tmp, this.filePath);
    }
}
//# sourceMappingURL=ban-registry.js.map