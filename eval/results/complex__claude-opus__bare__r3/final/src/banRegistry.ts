import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  issuanceId: string
  address: string
  reason: string
  bannedAt: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger has no "banned" flag: on ledger a banned holder is simply
 * unauthorized, locked and at zero balance. The registry is what stops the
 * issuer from ever re-approving or paying a banned address, so production
 * deployments should back it with the same database used for KYC decisions.
 */
export interface BanRegistry {
  isBanned(issuanceId: string, address: string): Promise<boolean>
  /** Record a ban. Must be durable before it resolves. Idempotent. */
  ban(record: BanRecord): Promise<void>
  list(issuanceId: string): Promise<BanRecord[]>
}

export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return this.records.has(key(issuanceId, address))
  }

  async ban(record: BanRecord): Promise<void> {
    const k = key(record.issuanceId, record.address)
    if (!this.records.has(k)) this.records.set(k, record)
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return [...this.records.values()].filter((r) => r.issuanceId === issuanceId)
  }
}

/**
 * JSON-file registry for single-process use (demos, tooling). Writes are
 * atomic (temp file + rename) and serialized within the process.
 */
export class FileBanRegistry implements BanRegistry {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    const records = await this.load()
    return records.some((r) => r.issuanceId === issuanceId && r.address === address)
  }

  async ban(record: BanRecord): Promise<void> {
    const write = this.writeChain.then(async () => {
      const records = await this.load()
      if (records.some((r) => r.issuanceId === record.issuanceId && r.address === record.address)) {
        return
      }
      records.push(record)
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
      await rename(tmp, this.path)
    })
    this.writeChain = write.catch(() => undefined)
    return write
  }

  async list(issuanceId: string): Promise<BanRecord[]> {
    return (await this.load()).filter((r) => r.issuanceId === issuanceId)
  }

  private async load(): Promise<BanRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error(`Ban registry ${this.path} is corrupt`)
      return parsed as BanRecord[]
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }
}

function key(issuanceId: string, address: string): string {
  return `${issuanceId}:${address}`
}
