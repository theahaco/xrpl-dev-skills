import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  issuanceId: string
  holder: string
  reason: string
  bannedAt: string
}

/**
 * Durable record of banned holders.
 *
 * The ledger cannot distinguish "banned" from "opted in but not yet approved" (both are an
 * unauthorized MPToken), so the ban list must live off-ledger and be consulted before any
 * approval or issuance. Back this with your system of record (e.g. a database table) in
 * production; {@link JsonFileBanStore} is suitable for a single process.
 */
export interface BanStore {
  get(issuanceId: string, holder: string): Promise<BanRecord | undefined>
  /** Must be durable before it resolves. Adding an existing ban keeps the original record. */
  add(record: BanRecord): Promise<void>
  list(issuanceId: string): Promise<BanRecord[]>
}

export class InMemoryBanStore implements BanStore {
  private readonly records = new Map<string, BanRecord>()

  async get(issuanceId: string, holder: string): Promise<BanRecord | undefined> {
    return this.records.get(key(issuanceId, holder))
  }

  async add(record: BanRecord): Promise<void> {
    const k = key(record.issuanceId, record.holder)
    if (!this.records.has(k)) this.records.set(k, { ...record })
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return [...this.records.values()].filter((r) => r.issuanceId === issuanceId)
  }
}

/** Ban store persisted to a JSON file with atomic replace-on-write. Single-process only. */
export class JsonFileBanStore implements BanStore {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async get(issuanceId: string, holder: string): Promise<BanRecord | undefined> {
    return (await this.read()).find((r) => r.issuanceId === issuanceId && r.holder === holder)
  }

  add(record: BanRecord): Promise<void> {
    const write = this.writeChain.then(async () => {
      const records = await this.read()
      if (records.some((r) => r.issuanceId === record.issuanceId && r.holder === record.holder)) return
      records.push({ ...record })
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(records, null, 2) + '\n', { flush: true })
      await rename(tmp, this.path)
    })
    this.writeChain = write.catch(() => undefined)
    return write
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return (await this.read()).filter((r) => r.issuanceId === issuanceId)
  }

  private async read(): Promise<BanRecord[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    // A corrupt ban list must fail closed, never be treated as empty.
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error(`Ban store ${this.path} is not a JSON array`)
    return parsed as BanRecord[]
  }
}

function key(issuanceId: string, holder: string): string {
  return `${issuanceId}:${holder}`
}
