"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonFileBanList = exports.InMemoryBanList = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
class InMemoryBanList {
    #records = new Map();
    async isBanned(address) {
        return this.#records.has(address);
    }
    async get(address) {
        return this.#records.get(address);
    }
    async add(record) {
        if (!this.#records.has(record.address)) {
            this.#records.set(record.address, { ...record });
        }
    }
    async list() {
        return [...this.#records.values()].map((r) => ({ ...r }));
    }
}
exports.InMemoryBanList = InMemoryBanList;
/**
 * Ban list persisted as a JSON file. Writes go to a temp file and are then
 * renamed into place, so a crash never leaves a truncated file. Suitable for
 * a single process; use a database-backed implementation for multiple
 * backend instances.
 */
class JsonFileBanList {
    path;
    #cache;
    #writeChain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async #load() {
        if (this.#cache !== undefined) {
            return this.#cache;
        }
        let records = [];
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(this.path, 'utf8'));
            if (!Array.isArray(parsed)) {
                throw new Error(`Ban list at ${this.path} is not a JSON array`);
            }
            records = parsed;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                // Fail closed: never treat an unreadable ban list as empty.
                throw error;
            }
        }
        this.#cache = new Map(records.map((r) => [r.address, r]));
        return this.#cache;
    }
    async isBanned(address) {
        return (await this.#load()).has(address);
    }
    async get(address) {
        return (await this.#load()).get(address);
    }
    async add(record) {
        const run = this.#writeChain.then(async () => {
            const records = await this.#load();
            if (records.has(record.address)) {
                return;
            }
            const next = new Map(records);
            next.set(record.address, { ...record });
            await (0, promises_1.mkdir)((0, node_path_1.dirname)(this.path), { recursive: true });
            const tmp = `${this.path}.${process.pid}.tmp`;
            await (0, promises_1.writeFile)(tmp, `${JSON.stringify([...next.values()], null, 2)}\n`, 'utf8');
            await (0, promises_1.rename)(tmp, this.path);
            this.#cache = next;
        });
        // Keep the chain alive after a failed write so later writes still run.
        this.#writeChain = run.catch(() => undefined);
        return run;
    }
    async list() {
        return [...(await this.#load()).values()].map((r) => ({ ...r }));
    }
}
exports.JsonFileBanList = JsonFileBanList;
//# sourceMappingURL=banList.js.map