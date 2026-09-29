import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Durable record of banned addresses.
 *
 * The XRP Ledger has no "banned" flag for MPT holders. A ban is enforced on
 * ledger by revoking the holder's authorization (the issuance requires auth),
 * locking their MPToken and clawing back their balance. But the holder can
 * delete their emptied MPToken and create a fresh one, which erases the lock.
 * The fresh MPToken is still unauthorized, so they still can't receive the
 * token. What keeps them out for good is that the issuer never authorizes
 * them again. This registry is the source of truth for that rule.
 *
 * Production deployments should back this with the compliance database.
 */
export interface BanRecord {
  address: string
  reason: string
  bannedAt: string
}

export interface BanRegistry {
  isBanned(address: string): Promise<boolean>
  get(address: string): Promise<BanRecord | undefined>
  /** Records a ban. Must be durable before it resolves. Idempotent: an existing record is kept. */
  add(record: BanRecord): Promise<void>
  list(): Promise<BanRecord[]>
}

export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

  async isBanned(address: string): Promise<boolean> {
    return this.records.has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return this.records.get(address)
  }

  async add(record: BanRecord): Promise<void> {
    if (!this.records.has(record.address)) this.records.set(record.address, { ...record })
  }

  async list(): Promise<BanRecord[]> {
    return [...this.records.values()]
  }
}

/**
 * JSON-file-backed registry. Writes go to a temp file and are then renamed
 * over the original, so a crash never leaves a half-written file. Meant for
 * one process only; there is no cross-process locking.
 */
export class JsonFileBanRegistry implements BanRegistry {
  private cache: Map<string, BanRecord> | undefined
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async isBanned(address: string): Promise<boolean> {
    return (await this.load()).has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.load()).get(address)
  }

  async list(): Promise<BanRecord[]> {
    return [...(await this.load()).values()]
  }

  async add(record: BanRecord): Promise<void> {
    const run = this.writeChain.then(async () => {
      const records = await this.load()
      if (records.has(record.address)) return
      records.set(record.address, { ...record })
      await this.persist(records)
    })
    // Keep the chain alive even if this write fails; the caller still sees the error.
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async load(): Promise<Map<string, BanRecord>> {
    if (this.cache) return this.cache
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = new Map()
        return this.cache
      }
      throw err
    }
    if (!Array.isArray(parsed)) throw new Error(`Ban registry ${this.filePath} is not a JSON array`)
    const records = new Map<string, BanRecord>()
    for (const entry of parsed as BanRecord[]) {
      if (typeof entry?.address !== 'string') throw new Error(`Ban registry ${this.filePath} has a malformed entry`)
      records.set(entry.address, entry)
    }
    this.cache = records
    return records
  }

  private async persist(records: Map<string, BanRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify([...records.values()], null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.filePath)
  }
}
