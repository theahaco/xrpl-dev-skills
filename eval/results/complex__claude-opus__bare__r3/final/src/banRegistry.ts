import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  bannedAt: string
}

/**
 * Durable record of banned addresses.
 *
 * On-ledger, a ban is enforced by revoking the holder's authorization (the
 * issuance requires auth, so an unauthorized holder can't receive the token).
 * The ledger can't stop the issuer from re-authorizing that holder later, so
 * this registry is the source of truth that stops that from happening. In
 * production, back this with the same database your compliance case
 * management uses.
 */
export interface BanRegistry {
  isBanned(address: string): Promise<boolean>
  get(address: string): Promise<BanRecord | undefined>
  /**
   * Must be durable before resolving. Idempotent: re-banning keeps the
   * original record. Resolves true if the ban is new.
   */
  add(record: BanRecord): Promise<boolean>
  list(): Promise<BanRecord[]>
}

/** Keeps bans in memory only. Suitable for tests. */
export class InMemoryBanRegistry implements BanRegistry {
  private readonly bans = new Map<string, BanRecord>()

  async isBanned(address: string): Promise<boolean> {
    return this.bans.has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return this.bans.get(address)
  }

  async add(record: BanRecord): Promise<boolean> {
    if (this.bans.has(record.address)) return false
    this.bans.set(record.address, record)
    return true
  }

  async list(): Promise<BanRecord[]> {
    return [...this.bans.values()]
  }
}

/**
 * JSON-file-backed registry with atomic writes (write to a temp file, then rename).
 * Single-process only: use a database-backed implementation if more than one
 * process can ban addresses.
 */
export class FileBanRegistry implements BanRegistry {
  private cache: Map<string, BanRecord> | undefined
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async isBanned(address: string): Promise<boolean> {
    return (await this.load()).has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.load()).get(address)
  }

  async list(): Promise<BanRecord[]> {
    return [...(await this.load()).values()]
  }

  add(record: BanRecord): Promise<boolean> {
    const op = this.writeChain.then(async () => {
      const bans = await this.load()
      if (bans.has(record.address)) return false
      const next = new Map(bans).set(record.address, record)
      await this.persist(next)
      this.cache = next
      return true
    })
    this.writeChain = op.then(
      () => undefined,
      () => undefined,
    )
    return op
  }

  private async load(): Promise<Map<string, BanRecord>> {
    if (this.cache) return this.cache
    let records: BanRecord[] = []
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error(`${this.path}: expected a JSON array`)
      records = parsed as BanRecord[]
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.cache = new Map(records.map((r) => [r.address, r]))
    return this.cache
  }

  private async persist(bans: Map<string, BanRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify([...bans.values()], null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.path)
  }
}
