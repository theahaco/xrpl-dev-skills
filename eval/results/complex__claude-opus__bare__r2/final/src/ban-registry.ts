import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  /** ISO-8601 timestamp of when the ban was recorded. */
  bannedAt: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger has no native "ban" state: a banned holder looks the same on
 * ledger as a holder who was never approved. This registry is what stops the
 * issuer from ever re-approving or paying a banned address, so production
 * deployments should back it with the same durable, audited store used for
 * KYC decisions.
 */
export interface BanRegistry {
  get(address: string): Promise<BanRecord | undefined>
  /** Must be durable before the returned promise resolves. Idempotent. */
  add(record: BanRecord): Promise<void>
}

export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

  async get(address: string): Promise<BanRecord | undefined> {
    return this.records.get(address)
  }

  async add(record: BanRecord): Promise<void> {
    if (!this.records.has(record.address)) this.records.set(record.address, record)
  }
}

/** Single-process registry persisted to a JSON file with atomic replace-on-write. */
export class JsonFileBanRegistry implements BanRegistry {
  private readonly path: string
  private writes: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.load())[address]
  }

  add(record: BanRecord): Promise<void> {
    const write = this.writes.then(async () => {
      const records = await this.load()
      if (records[record.address] !== undefined) return
      records[record.address] = record
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, this.path)
    })
    this.writes = write.catch(() => undefined)
    return write
  }

  private async load(): Promise<Record<string, BanRecord>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, BanRecord>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
}
