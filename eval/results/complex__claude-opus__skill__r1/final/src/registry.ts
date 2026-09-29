import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BanRecord {
  issuanceId: string;
  address: string;
  reason: string;
  bannedAt: string;
}

/**
 * Durable off-ledger compliance state the issuer module consults before acting.
 *
 * The ledger itself enforces that a banned holder cannot receive the token (their
 * holding is de-authorized), but an issuer-side authorization would undo that. The
 * registry is what makes a ban permanent: the issuer module refuses to authorize,
 * issue to, or unfreeze any address recorded here.
 *
 * Production deployments should back this with the same transactional database that
 * holds KYC decisions. `recordBan` must be durable before it resolves.
 */
export interface ComplianceRegistry {
  isBanned(issuanceId: string, address: string): Promise<boolean>;
  recordBan(record: BanRecord): Promise<void>;
  listBans(issuanceId: string): Promise<BanRecord[]>;
}

export class InMemoryComplianceRegistry implements ComplianceRegistry {
  protected bans: BanRecord[] = [];

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return this.bans.some((b) => b.issuanceId === issuanceId && b.address === address);
  }

  async recordBan(record: BanRecord): Promise<void> {
    if (!(await this.isBanned(record.issuanceId, record.address))) this.bans.push({ ...record });
  }

  async listBans(issuanceId: string): Promise<BanRecord[]> {
    return this.bans.filter((b) => b.issuanceId === issuanceId).map((b) => ({ ...b }));
  }
}

/**
 * Single-process JSON file registry, written atomically (temp file + rename).
 * Suitable for the demo and for single-instance deployments; not safe for
 * multiple processes writing the same file.
 */
export class JsonFileComplianceRegistry extends InMemoryComplianceRegistry {
  private writes: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<JsonFileComplianceRegistry> {
    const registry = new JsonFileComplianceRegistry(path);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { bans?: unknown };
      if (!Array.isArray(parsed.bans)) throw new Error(`${path}: missing "bans" array`);
      registry.bans = parsed.bans as BanRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return registry;
  }

  override async recordBan(record: BanRecord): Promise<void> {
    await super.recordBan(record);
    const snapshot = JSON.stringify({ bans: this.bans }, null, 2) + '\n';
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}
