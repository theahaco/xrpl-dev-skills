import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  issuanceId: string
  reason: string
  bannedAt: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger alone cannot guarantee a ban sticks: a banned holder whose balance
 * has been clawed back to zero can delete their MPToken entry (removing the
 * lock), and nothing on-ledger then stops the issuer from re-approving them.
 * The issuer module therefore consults this registry before every approval
 * or issuance. Production deployments should back it with the compliance
 * system's database.
 */
export interface BanRegistry {
  isBanned(issuanceId: string, address: string): Promise<boolean>
  recordBan(record: BanRecord): Promise<void>
}

/** Non-durable registry, suitable for tests only. */
export class InMemoryBanRegistry implements BanRegistry {
  readonly #bans = new Map<string, BanRecord>()

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return this.#bans.has(`${issuanceId}:${address}`)
  }

  async recordBan(record: BanRecord): Promise<void> {
    const key = `${record.issuanceId}:${record.address}`
    if (!this.#bans.has(key)) this.#bans.set(key, record)
  }
}

/** Registry persisted to a JSON file (atomic replace on every write). Single-process use only. */
export class JsonFileBanRegistry implements BanRegistry {
  readonly #path: string
  #queue: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
  }

  async #load(): Promise<BanRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error(`${this.#path} does not contain a JSON array`)
      return parsed as BanRecord[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    await this.#queue
    return (await this.#load()).some((r) => r.issuanceId === issuanceId && r.address === address)
  }

  recordBan(record: BanRecord): Promise<void> {
    const run = this.#queue.then(async () => {
      const records = await this.#load()
      if (records.some((r) => r.issuanceId === record.issuanceId && r.address === record.address)) return
      records.push(record)
      await mkdir(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
      await rename(tmp, this.#path)
    })
    this.#queue = run.catch(() => undefined)
    return run
  }
}
