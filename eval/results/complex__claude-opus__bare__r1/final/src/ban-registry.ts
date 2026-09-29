import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  /** ISO-8601 timestamp of when the ban was first recorded. */
  bannedAt: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger alone is not enough. A banned holder ends up unauthorized, which
 * on-ledger looks the same as a holder we never approved. The holder can also
 * delete its (zero-balance) MPToken entry, which removes any lock. This
 * registry is what stops an operator from approving a banned address again.
 *
 * There is deliberately no removal method. Lifting a ban is a manual,
 * out-of-band compliance decision, not an API call.
 *
 * In production, back this with the same transactional database the rest of
 * the compliance system uses.
 */
export interface BanRegistry {
  get(address: string): Promise<BanRecord | undefined>
  /** Adds a ban. If the address is already banned, keeps and returns the original record. */
  add(record: BanRecord): Promise<BanRecord>
  list(): Promise<BanRecord[]>
}

export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

  async get(address: string): Promise<BanRecord | undefined> {
    return this.records.get(address)
  }

  async add(record: BanRecord): Promise<BanRecord> {
    const existing = this.records.get(record.address)
    if (existing) return existing
    this.records.set(record.address, { ...record })
    return record
  }

  async list(): Promise<BanRecord[]> {
    return [...this.records.values()]
  }
}

/**
 * Ban registry stored as a JSON file, written atomically (temp file + fsync +
 * rename). Writes are serialized within one process only. Do not share the
 * file between several processes.
 */
export class JsonFileBanRegistry implements BanRegistry {
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.read())[address]
  }

  add(record: BanRecord): Promise<BanRecord> {
    const run = this.writes.then(async () => {
      const all = await this.read()
      const existing = all[record.address]
      if (existing) return existing
      all[record.address] = { ...record }
      await this.write(all)
      return record
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  async list(): Promise<BanRecord[]> {
    return Object.values(await this.read())
  }

  private async read(): Promise<Record<string, BanRecord>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    // Fail loudly on corruption: an unreadable ban list must never be treated as empty.
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Ban registry ${this.path} is corrupt`)
    }
    return parsed as Record<string, BanRecord>
  }

  private async write(all: Record<string, BanRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', flush: true })
    await rename(tmp, this.path)
  }
}
