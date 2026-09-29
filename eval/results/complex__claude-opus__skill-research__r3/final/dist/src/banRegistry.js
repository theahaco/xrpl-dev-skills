"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileBanRegistry = exports.InMemoryBanRegistry = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
class InMemoryBanRegistry {
    bans = new Map();
    async isBanned(issuanceId, address) {
        return this.bans.has(key(issuanceId, address));
    }
    async get(issuanceId, address) {
        return this.bans.get(key(issuanceId, address));
    }
    async record(ban) {
        const k = key(ban.issuanceId, ban.address);
        if (!this.bans.has(k))
            this.bans.set(k, ban);
    }
}
exports.InMemoryBanRegistry = InMemoryBanRegistry;
/**
 * JSON-file registry for single-process deployments and demos. Writes are
 * atomic (write to a temp file, then rename) and serialized within the process.
 */
class FileBanRegistry {
    path;
    writeChain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async isBanned(issuanceId, address) {
        return (await this.get(issuanceId, address)) !== undefined;
    }
    async get(issuanceId, address) {
        const all = await this.readAll();
        return all.find((b) => b.issuanceId === issuanceId && b.address === address);
    }
    async record(ban) {
        const write = this.writeChain.catch(() => undefined).then(async () => {
            const all = await this.readAll();
            if (all.some((b) => b.issuanceId === ban.issuanceId && b.address === ban.address))
                return;
            all.push(ban);
            await (0, promises_1.mkdir)((0, node_path_1.dirname)(this.path), { recursive: true });
            const tmp = `${this.path}.${process.pid}.tmp`;
            await (0, promises_1.writeFile)(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
            await (0, promises_1.rename)(tmp, this.path);
        });
        this.writeChain = write;
        await write;
    }
    async readAll() {
        try {
            return JSON.parse(await (0, promises_1.readFile)(this.path, 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
    }
}
exports.FileBanRegistry = FileBanRegistry;
function key(issuanceId, address) {
    return `${issuanceId}:${address}`;
}
//# sourceMappingURL=banRegistry.js.map