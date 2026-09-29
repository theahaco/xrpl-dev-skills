import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  /** ISO-8601 timestamp. */
  bannedAt: string
}

/**
 * Durable list of banned addresses.
 *
 * The ledger has no notion of a "ban": on-ledger, a banned holder is simply one
 * whose authorization was revoked, which looks the same as never having been
 * approved. The registry is what stops a banned address from being approved
 * (and therefore able to receive the token) again, so in production it must be
 * backed by durable, access-controlled storage (e.g. your compliance database).
 */
export interface BanRegistry {
  get(address: string): Promise<BanRecord | undefined>
  /** Must be durable before it resolves. Adding an already-banned address keeps the original record. */
  add(record: BanRecord): Promise<void>
  list(): Promise<BanRecord[]>
}

/** Non-durable registry for tests. */
export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

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
 * Registry persisted as a JSON file, written atomically (temp file + fsync +
 * rename). Suitable for a single process; use a database-backed implementation
 * when several backend instances share an issuer.
 */
export class FileBanRegistry implements BanRegistry {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.read()).find((r) => r.address === address)
  }

  async list(): Promise<BanRecord[]> {
    return this.read()
  }

  add(record: BanRecord): Promise<void> {
    const run = this.queue.then(async () => {
      const records = await this.read()
      if (records.some((r) => r.address === record.address)) return
      records.push({ ...record })
      await this.write(records)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<BanRecord[]> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error(`Ban registry ${this.filePath} is corrupt: expected an array`)
    return parsed as BanRecord[]
  }

  private async write(records: BanRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    const handle = await fs.open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(records, null, 2) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, this.filePath)
  }
}
