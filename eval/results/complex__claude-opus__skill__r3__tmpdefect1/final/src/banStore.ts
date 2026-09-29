import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BanRecord {
  address: string;
  issuanceId: string;
  reason: string;
  bannedAt: string;
  /** Set once the ban has been fully enforced on ledger. */
  enforcedAt?: string;
  txHashes: string[];
}

/**
 * Durable record of banned addresses. The ledger itself enforces that a
 * banned holder can't receive tokens (they are de-authorized and locked), but
 * only this store prevents an operator from later re-approving them, and it
 * survives the holder deleting their empty MPToken entry.
 *
 * Production deployments should back this with the same database as the
 * KYC/allowlist system (with appropriate access controls and audit trail).
 */
export interface BanStore {
  get(issuanceId: string, address: string): Promise<BanRecord | undefined>;
  put(record: BanRecord): Promise<void>;
  list(issuanceId: string): Promise<BanRecord[]>;
}

export class InMemoryBanStore implements BanStore {
  private readonly records = new Map<string, BanRecord>();

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    const record = this.records.get(key(issuanceId, address));
    return record && structuredClone(record);
  }

  async put(record: BanRecord): Promise<void> {
    this.records.set(key(record.issuanceId, record.address), structuredClone(record));
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return [...this.records.values()].filter((r) => r.issuanceId === issuanceId).map((r) => structuredClone(r));
  }
}

/**
 * JSON-file store with atomic replace-on-write. Suitable for a single
 * process (demos, tooling); not safe for concurrent writers.
 */
export class JsonFileBanStore implements BanStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    return (await this.load()).find((r) => r.issuanceId === issuanceId && r.address === address);
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return (await this.load()).filter((r) => r.issuanceId === issuanceId);
  }

  put(record: BanRecord): Promise<void> {
    const next = this.writeChain.then(async () => {
      const records = (await this.load()).filter(
        (r) => !(r.issuanceId === record.issuanceId && r.address === record.address),
      );
      records.push(record);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, this.path);
    });
    // Keep the chain alive after a failed write so later writes still run.
    this.writeChain = next.catch(() => {});
    return next;
  }

  private async load(): Promise<BanRecord[]> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as BanRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}

function key(issuanceId: string, address: string): string {
  return `${issuanceId}:${address}`;
}
