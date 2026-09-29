import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Mutex, type ComplianceStore, type Operation } from './issuer.js';
interface State { operations: Record<string, Operation>; bans: string[] }

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(`${path}.tmp`, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(`${path}.tmp`, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Single-process adapter. Keep on durable disk; use a transactional database in a backend cluster. */
export class FileStore implements ComplianceStore {
  private readonly mutex = new Mutex();
  private constructor(private readonly path: string, private state: State) {}
  static async load(path: string): Promise<FileStore> {
    let state: State = { operations: {}, bans: [] };
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !('operations' in parsed) || !('bans' in parsed) ||
        !parsed.operations || typeof parsed.operations !== 'object' || Array.isArray(parsed.operations) ||
        !Array.isArray(parsed.bans) || !parsed.bans.every(ban => typeof ban === 'string')) {
        throw new Error('Invalid compliance journal; refusing to reset policy');
      }
      for (const operation of Object.values(parsed.operations) as unknown[]) {
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
      state = parsed as State;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new FileStore(path, state);
  }
  async getOperation(key: string): Promise<Operation | undefined> {
    return Object.hasOwn(this.state.operations, key) ? structuredClone(this.state.operations[key]) : undefined;
  }
  async pendingOperation(): Promise<string | undefined> {
    return Object.entries(this.state.operations).find(([, value]) => !value.receipt)?.[0];
  }
  async putOperation(key: string, value: Operation): Promise<void> {
    await this.mutex.run(async () => {
      const next: State = { ...this.state, operations: { ...this.state.operations, [key]: structuredClone(value) } };
      await atomicJson(this.path, next);
      this.state = next;
    });
  }
  async isBanned(id: string, holder: string): Promise<boolean> { return this.state.bans.includes(`${id}:${holder}`); }
  async markBanned(id: string, holder: string): Promise<void> {
    await this.mutex.run(async () => {
      const key = `${id}:${holder}`;
      if (this.state.bans.includes(key)) return;
      const next: State = { ...this.state, bans: [...this.state.bans, key] };
      await atomicJson(this.path, next);
      this.state = next;
    });
  }
}
