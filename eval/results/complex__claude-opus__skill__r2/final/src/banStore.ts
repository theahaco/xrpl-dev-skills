import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  bannedAt: string
}

/**
 * Durable record of banned addresses, scoped per issuance.
 *
 * The ledger enforces a ban (the holder's authorization is revoked and the token
 * requires authorization), but the ledger cannot stop *us* from re-approving the
 * address later. This store is what makes the issuer module refuse to. In
 * production, back it with the same database as the KYC records.
 */
export interface BanStore {
  isBanned(issuanceId: string, address: string): Promise<boolean>
  add(issuanceId: string, record: BanRecord): Promise<void>
  list(issuanceId: string): Promise<BanRecord[]>
}

export class InMemoryBanStore implements BanStore {
  private readonly bans = new Map<string, Map<string, BanRecord>>()

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return this.bans.get(issuanceId)?.has(address) ?? false
  }

  async add(issuanceId: string, record: BanRecord): Promise<void> {
    let forIssuance = this.bans.get(issuanceId)
    if (!forIssuance) this.bans.set(issuanceId, (forIssuance = new Map()))
    if (!forIssuance.has(record.address)) forIssuance.set(record.address, record)
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return [...(this.bans.get(issuanceId)?.values() ?? [])]
  }
}

type BanFile = Record<string, BanRecord[]>

/**
 * JSON-file-backed store. Writes are atomic (write temp file, then rename) and
 * serialized within this process. Not safe for multiple processes sharing one
 * file; use a database-backed BanStore for that.
 */
export class FileBanStore implements BanStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return (await this.list(issuanceId)).some((r) => r.address === address)
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return (await this.read())[issuanceId] ?? []
  }

  add(issuanceId: string, record: BanRecord): Promise<void> {
    const op = this.queue.then(async () => {
      const data = await this.read()
      const records = (data[issuanceId] ??= [])
      if (records.some((r) => r.address === record.address)) return
      records.push(record)
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      await rename(tmp, this.path)
    })
    this.queue = op.catch(() => {})
    return op
  }

  private async read(): Promise<BanFile> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as BanFile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }
}
