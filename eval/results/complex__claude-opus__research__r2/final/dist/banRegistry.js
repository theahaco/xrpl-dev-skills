import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isValidClassicAddress } from 'xrpl';
export class InMemoryBanRegistry {
    records = new Map();
    async isBanned(address) {
        return this.records.has(address);
    }
    async add(record) {
        assertAddress(record.address);
        if (!this.records.has(record.address)) {
            this.records.set(record.address, { ...record });
        }
    }
    async get(address) {
        const record = this.records.get(address);
        return record === undefined ? undefined : { ...record };
    }
    async list() {
        return [...this.records.values()].map((r) => ({ ...r }));
    }
}
/**
 * JSON-file-backed registry. Writes are atomic (write a temp file, then rename)
 * and serialized within the process. Not safe for several processes writing
 * the same file.
 */
export class FileBanRegistry {
    path;
    writeChain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async isBanned(address) {
        return (await this.get(address)) !== undefined;
    }
    async get(address) {
        const file = await this.read();
        return file.bans.find((b) => b.address === address);
    }
    async list() {
        return (await this.read()).bans;
    }
    add(record) {
        try {
            assertAddress(record.address);
        }
        catch (error) {
            return Promise.reject(error);
        }
        const next = this.writeChain.then(async () => {
            const file = await this.read();
            if (file.bans.some((b) => b.address === record.address)) {
                return;
            }
            file.bans.push({ ...record });
            await this.write(file);
        });
        // Keep the chain alive even if this write fails; the caller still sees the error.
        this.writeChain = next.catch(() => undefined);
        return next;
    }
    async read() {
        let raw;
        try {
            raw = await readFile(this.path, 'utf8');
        }
        catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return { version: 1, bans: [] };
            }
            throw error;
        }
        const parsed = JSON.parse(raw);
        if (!isBanFile(parsed)) {
            // Fail closed. A corrupt ban list must never be read as "nobody is banned".
            throw new Error(`Ban registry at ${this.path} is malformed; refusing to continue`);
        }
        return parsed;
    }
    async write(file) {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, this.path);
    }
}
function assertAddress(address) {
    if (!isValidClassicAddress(address)) {
        throw new Error(`Not a valid classic address: ${address}`);
    }
}
function isBanFile(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    return (v.version === 1 &&
        Array.isArray(v.bans) &&
        v.bans.every((b) => typeof b === 'object' &&
            b !== null &&
            typeof b.address === 'string' &&
            typeof b.bannedAt === 'string'));
}
function isErrnoException(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=banRegistry.js.map