import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Mutex } from './issuer.js';
export async function atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(`${path}.tmp`, 'w', 0o600);
    try {
        await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(`${path}.tmp`, path);
    const directory = await open(dirname(path), 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
/** Single-process adapter. Keep on durable disk; use a transactional database in a backend cluster. */
export class FileStore {
    path;
    state;
    mutex = new Mutex();
    constructor(path, state) {
        this.path = path;
        this.state = state;
    }
    static async load(path) {
        let state = { operations: {}, bans: [] };
        try {
            const parsed = JSON.parse(await readFile(path, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || !('operations' in parsed) || !('bans' in parsed) ||
                !parsed.operations || typeof parsed.operations !== 'object' || Array.isArray(parsed.operations) ||
                !Array.isArray(parsed.bans) || !parsed.bans.every(ban => typeof ban === 'string')) {
                throw new Error('Invalid compliance journal; refusing to reset policy');
            }
            for (const operation of Object.values(parsed.operations)) {
                if (!operation || typeof operation !== 'object' || !('intent' in operation) || typeof operation.intent !== 'string' ||
                    !('blob' in operation) || typeof operation.blob !== 'string' || !('hash' in operation) || typeof operation.hash !== 'string' ||
                    !('lastLedger' in operation) || !Number.isInteger(operation.lastLedger)) {
                    throw new Error('Invalid operation in compliance journal');
                }
                if ('receipt' in operation) {
                    const receipt = operation.receipt;
                    if (!receipt || typeof receipt !== 'object' || !('hash' in receipt) || receipt.hash !== operation.hash ||
                        !('code' in receipt) || typeof receipt.code !== 'string' || !('ledgerIndex' in receipt) || !Number.isInteger(receipt.ledgerIndex)) {
                        throw new Error('Invalid receipt in compliance journal');
                    }
                }
            }
            state = parsed;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        return new FileStore(path, state);
    }
    async getOperation(key) {
        return Object.hasOwn(this.state.operations, key) ? structuredClone(this.state.operations[key]) : undefined;
    }
    async pendingOperation() {
        return Object.entries(this.state.operations).find(([, value]) => !value.receipt)?.[0];
    }
    async putOperation(key, value) {
        await this.mutex.run(async () => {
            const next = { ...this.state, operations: { ...this.state.operations, [key]: structuredClone(value) } };
            await atomicJson(this.path, next);
            this.state = next;
        });
    }
    async isBanned(id, holder) { return this.state.bans.includes(`${id}:${holder}`); }
    async markBanned(id, holder) {
        await this.mutex.run(async () => {
            const key = `${id}:${holder}`;
            if (this.state.bans.includes(key))
                return;
            const next = { ...this.state, bans: [...this.state.bans, key] };
            await atomicJson(this.path, next);
            this.state = next;
        });
    }
}
