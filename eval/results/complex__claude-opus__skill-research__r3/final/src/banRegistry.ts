import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  issuanceId: string
  address: string
  reason: string
  bannedAt: string
}

/**
 * Durable record of banned addresses. The ledger enforces a ban by leaving the
 * holder unauthorized; this registry makes sure the issuer never re-approves
 * them. Production deployments should back this with the compliance database.
 */
export interface BanRegistry {
  isBanned(issuanceId: string, address: string): Promise<boolean>
  get(issuanceId: string, address: string): Promise<BanRecord | undefined>
  /** Must be durable before it resolves: the ban is recorded before any ledger action. */
  record(ban: BanRecord): Promise<void>
}

export class InMemoryBanRegistry implements BanRegistry {
  private readonly bans = new Map<string, BanRecord>()

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return this.bans.has(key(issuanceId, address))
  }

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    return this.bans.get(key(issuanceId, address))
  }

  async record(ban: BanRecord): Promise<void> {
    const k = key(ban.issuanceId, ban.address)
    if (!this.bans.has(k)) this.bans.set(k, ban)
  }
}

/**
 * JSON-file registry for single-process deployments and demos. Writes are
 * atomic (write to a temp file, then rename) and serialized within the process.
 */
export class FileBanRegistry implements BanRegistry {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return (await this.get(issuanceId, address)) !== undefined
  }

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    const all = await this.readAll()
    return all.find((b) => b.issuanceId === issuanceId && b.address === address)
  }

  async record(ban: BanRecord): Promise<void> {
    const write = this.writeChain.catch(() => undefined).then(async () => {
      const all = await this.readAll()
      if (all.some((b) => b.issuanceId === ban.issuanceId && b.address === ban.address)) return
      all.push(ban)
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, this.path)
    })
    this.writeChain = write
    await write
  }

  private async readAll(): Promise<BanRecord[]> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as BanRecord[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}

function key(issuanceId: string, address: string): string {
  return `${issuanceId}:${address}`
}
