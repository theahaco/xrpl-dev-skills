import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BanRecord {
  address: string;
  reason: string;
  bannedAt: string;
}

/**
 * Durable record of banned addresses.
 *
 * The XRP Ledger has no "ban" primitive: on-ledger, a ban is enforced by
 * revoking the holder's authorization on a Require-Auth issuance, and the
 * issuer is able to re-authorize anyone at any time. This registry is what
 * stops the issuer module from ever re-authorizing a banned address, so
 * production deployments must back it with durable, shared storage (e.g. the
 * compliance database) rather than process memory.
 */
export interface BanRegistry {
  isBanned(address: string): Promise<boolean>;
  /** Idempotent: re-recording an existing ban keeps the original record. */
  recordBan(address: string, reason: string): Promise<void>;
  list(): Promise<BanRecord[]>;
}

/** Non-durable registry for tests. */
export class InMemoryBanRegistry implements BanRegistry {
  private readonly bans = new Map<string, BanRecord>();

  async isBanned(address: string): Promise<boolean> {
    return this.bans.has(address);
  }

  async recordBan(address: string, reason: string): Promise<void> {
    if (!this.bans.has(address)) this.bans.set(address, { address, reason, bannedAt: new Date().toISOString() });
  }

  async list(): Promise<BanRecord[]> {
    return [...this.bans.values()];
  }
}

/**
 * Single-process registry persisted to a JSON file with atomic replace.
 * Suitable for the demo and for single-instance deployments; use a database
 * implementation when several backend instances share one issuer.
 */
export class JsonFileBanRegistry implements BanRegistry {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async isBanned(address: string): Promise<boolean> {
    return (await this.read()).some((record) => record.address === address);
  }

  recordBan(address: string, reason: string): Promise<void> {
    const run = this.writes.then(async () => {
      const records = await this.read();
      if (records.some((record) => record.address === address)) return;
      records.push({ address, reason, bannedAt: new Date().toISOString() });
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  list(): Promise<BanRecord[]> {
    return this.read();
  }

  private async read(): Promise<BanRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`Ban registry ${this.path} is corrupt: expected an array`);
    return parsed as BanRecord[];
  }
}
