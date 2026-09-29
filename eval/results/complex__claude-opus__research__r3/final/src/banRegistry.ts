import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  issuanceId: string
  address: string
  reason: string
  /** ISO-8601 timestamp. */
  bannedAt: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger alone cannot keep an address banned forever: the ban removes the
 * holder's authorization, but if the holder later deletes and re-creates its
 * MPToken entry, nothing on ledger distinguishes it from a new applicant.
 * The issuer module therefore consults this registry before every
 * authorization and issuance, and writes to it *before* touching the ledger
 * when banning (fail closed).
 *
 * In production, back this with your compliance database. Implementations
 * must be durable before `ban` resolves.
 */
export interface BanRegistry {
  isBanned(issuanceId: string, address: string): Promise<boolean>
  ban(record: BanRecord): Promise<void>
  list(issuanceId: string): Promise<BanRecord[]>
}

function key(issuanceId: string, address: string): string {
  return `${issuanceId.toUpperCase()}:${address}`
}

export class InMemoryBanRegistry implements BanRegistry {
  readonly #records = new Map<string, BanRecord>()

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return this.#records.has(key(issuanceId, address))
  }

  async ban(record: BanRecord): Promise<void> {
    const k = key(record.issuanceId, record.address)
    if (!this.#records.has(k)) {
      this.#records.set(k, { ...record })
    }
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    const id = issuanceId.toUpperCase()
    return [...this.#records.values()].filter((r) => r.issuanceId.toUpperCase() === id)
  }
}

/**
 * JSON-file-backed registry, suitable for a single process. Writes are
 * serialized and atomic (write temp file, then rename).
 */
export class JsonFileBanRegistry implements BanRegistry {
  readonly #path: string
  #records: Map<string, BanRecord> | undefined
  #writeChain: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
  }

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return (await this.#load()).has(key(issuanceId, address))
  }

  async ban(record: BanRecord): Promise<void> {
    const run = async (): Promise<void> => {
      const records = await this.#load()
      const k = key(record.issuanceId, record.address)
      if (records.has(k)) return
      const next = new Map(records)
      next.set(k, { ...record })
      await this.#persist(next)
      this.#records = next
    }
    const result = this.#writeChain.then(run)
    this.#writeChain = result.catch(() => undefined)
    return result
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    const id = issuanceId.toUpperCase()
    return [...(await this.#load()).values()].filter((r) => r.issuanceId.toUpperCase() === id)
  }

  async #load(): Promise<Map<string, BanRecord>> {
    if (this.#records) return this.#records
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.#path, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#records = new Map()
        return this.#records
      }
      // Fail closed: an unreadable ban list must not be treated as empty.
      throw new Error(`Cannot read ban registry at ${this.#path}`, { cause: err })
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Ban registry at ${this.#path} is malformed`)
    }
    const records = new Map<string, BanRecord>()
    for (const r of parsed as BanRecord[]) {
      records.set(key(r.issuanceId, r.address), r)
    }
    this.#records = records
    return records
  }

  async #persist(records: Map<string, BanRecord>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify([...records.values()], null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.#path)
  }
}
