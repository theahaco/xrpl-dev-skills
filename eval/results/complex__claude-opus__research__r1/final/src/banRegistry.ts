import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  /** ISO-8601 timestamp of when the ban was recorded. */
  bannedAt: string
  reason?: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger has no "banned" state for MPT holders: a banned holder looks the
 * same on-ledger as one that was never approved. On networks without the
 * `fixCleanup3_4_0` amendment (including testnet at the time of writing), a
 * banned holder can even delete their zero-balance, locked MPToken and create
 * a fresh one. This registry is what stops the issuer from re-approving or
 * paying a banned address. Back it with durable, access-controlled storage
 * (your database) in production.
 *
 * Implementations must make `add` durable before resolving.
 */
export interface BanRegistry {
  isBanned(address: string): Promise<boolean>
  get(address: string): Promise<BanRecord | undefined>
  /** Idempotent: re-banning keeps the original record. */
  add(record: BanRecord): Promise<void>
  list(): Promise<BanRecord[]>
}

/** Non-durable registry for tests and short-lived scripts. */
export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

  async isBanned(address: string): Promise<boolean> {
    return this.records.has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return this.records.get(address)
  }

  async add(record: BanRecord): Promise<void> {
    if (!this.records.has(record.address)) {
      this.records.set(record.address, { ...record })
    }
  }

  async list(): Promise<BanRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }))
  }
}

/**
 * JSON-file registry. Writes go to a temporary file that is then renamed
 * over the original, so a crash never leaves a truncated file. Suitable for a
 * single process; use a database-backed implementation for multi-instance
 * deployments.
 */
export class JsonFileBanRegistry implements BanRegistry {
  private readonly path: string
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  async isBanned(address: string): Promise<boolean> {
    return (await this.get(address)) !== undefined
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.read()).find((record) => record.address === address)
  }

  async list(): Promise<BanRecord[]> {
    return this.read()
  }

  async add(record: BanRecord): Promise<void> {
    const task = this.writeChain.then(async () => {
      const records = await this.read()
      if (records.some((existing) => existing.address === record.address)) {
        return
      }
      records.push({ ...record })
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { flush: true })
      await rename(tmp, this.path)
    })
    this.writeChain = task.catch(() => undefined)
    return task
  }

  private async read(): Promise<BanRecord[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || !parsed.every(isBanRecord)) {
      // Fail closed: never treat a corrupt ban list as "nobody is banned".
      throw new Error(`Ban registry ${this.path} is corrupt`)
    }
    return parsed
  }
}

function isBanRecord(value: unknown): value is BanRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record['address'] === 'string' &&
    typeof record['bannedAt'] === 'string' &&
    (record['reason'] === undefined || typeof record['reason'] === 'string')
  )
}
