import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  /** ISO-8601 timestamp of when the ban was recorded. */
  bannedAt: string
}

/**
 * Durable record of banned addresses, owned by the backend.
 *
 * The ledger enforces a ban by revoking the holder's authorization, but
 * nothing on the ledger stops the issuer from authorizing that address again
 * later. On testnet (without the fixCleanup3_4_0 amendment) the holder can
 * also delete their locked, empty MPToken entry, which removes any on-ledger
 * trace of the ban. This list is therefore the source of truth: the issuer
 * module consults it before approving or issuing to anyone.
 *
 * Production deployments should back this with the compliance database.
 */
export interface BanList {
  isBanned(address: string): Promise<boolean>
  get(address: string): Promise<BanRecord | undefined>
  /** Idempotent: re-adding an existing address keeps the original record. */
  add(record: BanRecord): Promise<void>
  list(): Promise<BanRecord[]>
}

export class InMemoryBanList implements BanList {
  readonly #records = new Map<string, BanRecord>()

  async isBanned(address: string): Promise<boolean> {
    return this.#records.has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return this.#records.get(address)
  }

  async add(record: BanRecord): Promise<void> {
    if (!this.#records.has(record.address)) {
      this.#records.set(record.address, { ...record })
    }
  }

  async list(): Promise<BanRecord[]> {
    return [...this.#records.values()].map((r) => ({ ...r }))
  }
}

/**
 * Ban list persisted as a JSON file. Writes go to a temp file and are then
 * renamed into place, so a crash never leaves a truncated file. Suitable for
 * a single process; use a database-backed implementation for multiple
 * backend instances.
 */
export class JsonFileBanList implements BanList {
  #cache: Map<string, BanRecord> | undefined
  #writeChain: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async #load(): Promise<Map<string, BanRecord>> {
    if (this.#cache !== undefined) {
      return this.#cache
    }
    let records: BanRecord[] = []
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed)) {
        throw new Error(`Ban list at ${this.path} is not a JSON array`)
      }
      records = parsed as BanRecord[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Fail closed: never treat an unreadable ban list as empty.
        throw error
      }
    }
    this.#cache = new Map(records.map((r) => [r.address, r]))
    return this.#cache
  }

  async isBanned(address: string): Promise<boolean> {
    return (await this.#load()).has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.#load()).get(address)
  }

  async add(record: BanRecord): Promise<void> {
    const run = this.#writeChain.then(async () => {
      const records = await this.#load()
      if (records.has(record.address)) {
        return
      }
      const next = new Map(records)
      next.set(record.address, { ...record })
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify([...next.values()], null, 2)}\n`, 'utf8')
      await rename(tmp, this.path)
      this.#cache = next
    })
    // Keep the chain alive after a failed write so later writes still run.
    this.#writeChain = run.catch(() => undefined)
    return run
  }

  async list(): Promise<BanRecord[]> {
    return [...(await this.#load()).values()].map((r) => ({ ...r }))
  }
}
