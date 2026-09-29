import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  issuanceId: string
  reason: string
  /** ISO-8601 timestamp of when the ban was recorded. */
  bannedAt: string
  /** Hashes of the ledger transactions that enforced the ban, filled in as they succeed. */
  txHashes: string[]
}

/**
 * Durable record of banned addresses. The ledger alone can't express "never
 * re-authorize this address", so the issuer consults this list before every
 * authorization and payment. Back it with your primary database in production.
 */
export interface BanList {
  get(address: string): Promise<BanRecord | undefined>
  /** Inserts or replaces the record for `record.address`. */
  put(record: BanRecord): Promise<void>
  list(): Promise<BanRecord[]>
}

/** Process-local ban list, for tests. Not durable. */
export class InMemoryBanList implements BanList {
  readonly #records = new Map<string, BanRecord>()

  async get(address: string): Promise<BanRecord | undefined> {
    const record = this.#records.get(address)
    return record && structuredClone(record)
  }

  async put(record: BanRecord): Promise<void> {
    this.#records.set(record.address, structuredClone(record))
  }

  async list(): Promise<BanRecord[]> {
    return [...this.#records.values()].map((r) => structuredClone(r))
  }
}

/**
 * Ban list persisted to a JSON file. Writes go to a temporary file which is
 * then renamed over the original, so a crash never leaves a half-written file.
 * Safe for concurrent use within one process; not for multiple processes.
 */
export class FileBanList implements BanList {
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async get(address: string): Promise<BanRecord | undefined> {
    const records = await this.#serialized(() => this.#read())
    return records[address]
  }

  async put(record: BanRecord): Promise<void> {
    await this.#serialized(async () => {
      const records = await this.#read()
      records[record.address] = record
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, this.path)
    })
  }

  async list(): Promise<BanRecord[]> {
    return Object.values(await this.#serialized(() => this.#read()))
  }

  async #read(): Promise<Record<string, BanRecord>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Ban list ${this.path} is not a JSON object`)
      }
      return parsed as Record<string, BanRecord>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  #serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn)
    this.#queue = result.catch(() => undefined)
    return result
  }
}
