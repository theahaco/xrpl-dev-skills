import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BanRecord {
  address: string;
  issuanceId: string;
  reason: string;
  /** ISO-8601 timestamp. */
  bannedAt: string;
}

/**
 * Durable record of banned addresses.
 *
 * The ledger enforces a ban by leaving the holder unauthorized under
 * RequireAuth, but the ledger has no "banned" flag. Only this registry stops a
 * future `authorizeHolder` call from re-approving the address. In production,
 * back it with the compliance system of record (a database table with an audit
 * trail), not a local file.
 */
export interface BanRegistry {
  get(issuanceId: string, address: string): Promise<BanRecord | undefined>;
  /** Must be durable before it resolves. */
  add(record: BanRecord): Promise<void>;
  list(issuanceId: string): Promise<BanRecord[]>;
}

export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>();

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    return this.records.get(`${issuanceId}:${address}`);
  }

  async add(record: BanRecord): Promise<void> {
    const key = `${record.issuanceId}:${record.address}`;
    if (!this.records.has(key)) this.records.set(key, { ...record });
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return [...this.records.values()].filter((r) => r.issuanceId === issuanceId);
  }
}

/**
 * JSON-file registry, suitable for a single process. Writes are atomic
 * (write to a temp file, then rename) and serialized within the process.
 */
export class FileBanRegistry implements BanRegistry {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    return (await this.load()).find((r) => r.issuanceId === issuanceId && r.address === address);
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return (await this.load()).filter((r) => r.issuanceId === issuanceId);
  }

  add(record: BanRecord): Promise<void> {
    const run = this.writeChain.then(async () => {
      const records = await this.load();
      if (records.some((r) => r.issuanceId === record.issuanceId && r.address === record.address)) return;
      records.push({ ...record });
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<BanRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error(`${this.path} is not a JSON array`);
      return parsed as BanRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
