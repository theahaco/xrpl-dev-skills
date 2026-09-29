import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
export class InMemoryBanRegistry {
    #records = new Map();
    async isBanned(address) {
        return this.#records.has(address);
    }
    async get(address) {
        return this.#records.get(address);
    }
    async add(record) {
        if (!this.#records.has(record.address))
            this.#records.set(record.address, { ...record });
    }
    async list() {
        return [...this.#records.values()].map((r) => ({ ...r }));
    }
}
/**
 * JSON-file registry for single-process deployments and demos. Writes go to a
 * temporary file that is then renamed into place, so a crash can't leave a
 * half-written file.
 */
export class JsonFileBanRegistry {
    path;
    #cache;
    #writeChain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async isBanned(address) {
        return (await this.#load()).has(address);
    }
    async get(address) {
        const record = (await this.#load()).get(address);
        return record && { ...record };
    }
    async add(record) {
        const write = this.#writeChain.then(async () => {
            const records = await this.#load();
            if (records.has(record.address))
                return;
            const next = new Map(records).set(record.address, { ...record });
            await this.#persist(next);
            this.#cache = next;
        });
        this.#writeChain = write.catch(() => undefined);
        return write;
    }
    async list() {
        return [...(await this.#load()).values()].map((r) => ({ ...r }));
    }
    async #load() {
        if (this.#cache)
            return this.#cache;
        let raw;
        try {
            raw = await readFile(this.path, 'utf8');
        }
        catch (err) {
            if (err.code === 'ENOENT') {
                this.#cache = new Map();
                return this.#cache;
            }
            throw err;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            throw new Error(`Ban registry ${this.path} is not a JSON array`);
        this.#cache = new Map(parsed.map((r) => [r.address, r]));
        return this.#cache;
    }
    async #persist(records) {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.${process.pid}.tmp`;
        const file = await open(tmp, 'w', 0o600);
        try {
            await file.writeFile(JSON.stringify([...records.values()], null, 2) + '\n', 'utf8');
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(tmp, this.path);
    }
}
//# sourceMappingURL=banRegistry.js.map