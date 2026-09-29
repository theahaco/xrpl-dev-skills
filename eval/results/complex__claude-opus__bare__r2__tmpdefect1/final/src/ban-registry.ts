import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The ledger has no "banned" marker: a ban shows up there as an unauthorized,
 * locked MPToken with a zero balance. A holder can delete that MPToken and
 * create a fresh, unauthorized one, so the ban itself has to be remembered
 * off-ledger. That way a later KYC approval can never re-admit the address.
 *
 * Production deployments should implement this interface against the
 * system of record (e.g. the compliance database). FileBanRegistry is a
 * durable single-process implementation for small deployments and demos.
 */
export interface BanRecord {
  issuanceId: string
  address: string
  reason: string
  bannedAt: string
}

export interface BanRegistry {
  get(issuanceId: string, address: string): Promise<BanRecord | undefined>
  /** Must be durable before it resolves: the ban is recorded before any ledger action. */
  add(record: BanRecord): Promise<void>
}

const key = (issuanceId: string, address: string): string => `${issuanceId}:${address}`

export class InMemoryBanRegistry implements BanRegistry {
  private readonly records = new Map<string, BanRecord>()

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    return this.records.get(key(issuanceId, address))
  }

  async add(record: BanRecord): Promise<void> {
    const k = key(record.issuanceId, record.address)
    if (!this.records.has(k)) this.records.set(k, record)
  }
}

/**
 * JSON-file registry. Writes are atomic (temp file + fsync + rename) and
 * serialized within the process. Not safe for multiple writer processes.
 */
export class FileBanRegistry implements BanRegistry {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async get(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    await this.writeChain
    const records = await this.load()
    return records.find((r) => r.issuanceId === issuanceId && r.address === address)
  }

  add(record: BanRecord): Promise<void> {
    const next = this.writeChain.then(async () => {
      const records = await this.load()
      if (records.some((r) => r.issuanceId === record.issuanceId && r.address === record.address)) return
      records.push(record)
      await this.save(records)
    })
    // Keep the chain alive after a failed write; the caller still sees the error.
    this.writeChain = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<BanRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error(`Ban registry ${this.path} is corrupt: expected an array`)
    return parsed as BanRecord[]
  }

  private async save(records: BanRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(records, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, this.path)
  }
}
