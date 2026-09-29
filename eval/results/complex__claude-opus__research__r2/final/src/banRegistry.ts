import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isValidClassicAddress } from 'xrpl'

/**
 * Durable record of banned holder addresses.
 *
 * The ledger itself cannot durably remember a ban:
 *  - Under Require Auth, a holder can only receive the token while the issuer
 *    has authorized their MPToken entry. Banning revokes that authorization,
 *    and it stays revoked only as long as the issuer never re-authorizes.
 *  - Once a banned holder's balance is zero, they can delete their MPToken
 *    entry (on testnet this is possible even while it is locked, because the
 *    fixCleanup3_4_0 amendment is not enabled). A new MPToken entry starts out
 *    unauthorized, so the address still cannot receive tokens. But no on-ledger
 *    trace of the ban remains.
 *
 * So the issuer's backend must remember bans and refuse to authorize those
 * addresses again. In production, back this with your system of record (a
 * database table with an audit trail). The file-based implementation below is
 * suitable for the demo and for single-process deployments.
 */
export interface BanRecord {
  address: string
  bannedAt: string
  reason?: string
}

export interface BanRegistry {
  isBanned(address: string): Promise<boolean>
  /** Record a ban. Must be durable before it resolves. Idempotent. */
  add(record: BanRecord): Promise<void>
  get(address: string): Promise<BanRecord | undefined>
  list(): Promise<BanRecord[]>
}

export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

  async isBanned(address: string): Promise<boolean> {
    return this.records.has(address)
  }

  async add(record: BanRecord): Promise<void> {
    assertAddress(record.address)
    if (!this.records.has(record.address)) {
      this.records.set(record.address, { ...record })
    }
  }

  async get(address: string): Promise<BanRecord | undefined> {
    const record = this.records.get(address)
    return record === undefined ? undefined : { ...record }
  }

  async list(): Promise<BanRecord[]> {
    return [...this.records.values()].map((r) => ({ ...r }))
  }
}

interface BanFile {
  version: 1
  bans: BanRecord[]
}

/**
 * JSON-file-backed registry. Writes are atomic (write a temp file, then rename)
 * and serialized within the process. Not safe for several processes writing
 * the same file.
 */
export class FileBanRegistry implements BanRegistry {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async isBanned(address: string): Promise<boolean> {
    return (await this.get(address)) !== undefined
  }

  async get(address: string): Promise<BanRecord | undefined> {
    const file = await this.read()
    return file.bans.find((b) => b.address === address)
  }

  async list(): Promise<BanRecord[]> {
    return (await this.read()).bans
  }

  add(record: BanRecord): Promise<void> {
    try {
      assertAddress(record.address)
    } catch (error) {
      return Promise.reject(error)
    }
    const next = this.writeChain.then(async () => {
      const file = await this.read()
      if (file.bans.some((b) => b.address === record.address)) {
        return
      }
      file.bans.push({ ...record })
      await this.write(file)
    })
    // Keep the chain alive even if this write fails; the caller still sees the error.
    this.writeChain = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<BanFile> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return { version: 1, bans: [] }
      }
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isBanFile(parsed)) {
      // Fail closed. A corrupt ban list must never be read as "nobody is banned".
      throw new Error(`Ban registry at ${this.path} is malformed; refusing to continue`)
    }
    return parsed
  }

  private async write(file: BanFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.path)
  }
}

function assertAddress(address: string): void {
  if (!isValidClassicAddress(address)) {
    throw new Error(`Not a valid classic address: ${address}`)
  }
}

function isBanFile(value: unknown): value is BanFile {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { version?: unknown; bans?: unknown }
  return (
    v.version === 1 &&
    Array.isArray(v.bans) &&
    v.bans.every(
      (b: unknown) =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as BanRecord).address === 'string' &&
        typeof (b as BanRecord).bannedAt === 'string',
    )
  )
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
