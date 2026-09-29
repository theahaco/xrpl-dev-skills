import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  bannedAt: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger can revoke a holder's authorization, but it can't stop the issuer from
 * authorizing that holder again later. A holder can also delete their zero-balance
 * MPToken entry and create a fresh one, which drops the lock flag. The registry is
 * therefore the source of truth for bans. In production, back it with your database.
 */
export interface BanRegistry {
  isBanned(address: string): Promise<boolean>
  get(address: string): Promise<BanRecord | undefined>
  /** Must be durable before it resolves; a ban is recorded before any ledger action. */
  add(record: BanRecord): Promise<void>
  list(): Promise<BanRecord[]>
}

export class InMemoryBanRegistry implements BanRegistry {
  readonly #records = new Map<string, BanRecord>()

  async isBanned(address: string): Promise<boolean> {
    return this.#records.has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    return this.#records.get(address)
  }

  async add(record: BanRecord): Promise<void> {
    if (!this.#records.has(record.address)) this.#records.set(record.address, { ...record })
  }

  async list(): Promise<BanRecord[]> {
    return [...this.#records.values()].map((r) => ({ ...r }))
  }
}

/**
 * JSON-file registry for single-process deployments and demos. Writes go to a
 * temporary file that is then renamed into place, so a crash can't leave a
 * half-written file.
 */
export class JsonFileBanRegistry implements BanRegistry {
  #cache: Map<string, BanRecord> | undefined
  #writeChain: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async isBanned(address: string): Promise<boolean> {
    return (await this.#load()).has(address)
  }

  async get(address: string): Promise<BanRecord | undefined> {
    const record = (await this.#load()).get(address)
    return record && { ...record }
  }

  async add(record: BanRecord): Promise<void> {
    const write = this.#writeChain.then(async () => {
      const records = await this.#load()
      if (records.has(record.address)) return
      const next = new Map(records).set(record.address, { ...record })
      await this.#persist(next)
      this.#cache = next
    })
    this.#writeChain = write.catch(() => undefined)
    return write
  }

  async list(): Promise<BanRecord[]> {
    return [...(await this.#load()).values()].map((r) => ({ ...r }))
  }

  async #load(): Promise<Map<string, BanRecord>> {
    if (this.#cache) return this.#cache
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#cache = new Map()
        return this.#cache
      }
      throw err
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error(`Ban registry ${this.path} is not a JSON array`)
    this.#cache = new Map((parsed as BanRecord[]).map((r) => [r.address, r]))
    return this.#cache
  }

  async #persist(records: Map<string, BanRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    const file = await open(tmp, 'w', 0o600)
    try {
      await file.writeFile(JSON.stringify([...records.values()], null, 2) + '\n', 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, this.path)
  }
}
