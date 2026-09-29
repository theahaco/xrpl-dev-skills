import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  address: string
  reason: string
  bannedAt: string
  /** Set once the on-ledger enforcement (lock, clawback, de-authorization) has been verified. */
  enforcedAt?: string
}

/**
 * Durable record of banned addresses.
 *
 * The ledger has no native "ban": a ban is enforced on-ledger by locking the
 * holder, clawing back their balance and removing their authorization. The
 * ledger cannot stop a holder from deleting their emptied MPToken and opting
 * in again, so what keeps them out is RequireAuth plus the issuer refusing to
 * re-authorize them. This store is the source of truth for that refusal and
 * must therefore be durable and shared by every process that can approve holders.
 * Back it with your primary database in production.
 */
export interface BanStore {
  get(address: string): Promise<BanRecord | undefined>
  put(record: BanRecord): Promise<void>
  list(): Promise<BanRecord[]>
}

/**
 * JSON-file BanStore for single-process deployments and demos. Writes are
 * serialized and atomic (write temp file, fsync, rename).
 */
export class FileBanStore implements BanStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async get(address: string): Promise<BanRecord | undefined> {
    return (await this.read())[address]
  }

  async list(): Promise<BanRecord[]> {
    return Object.values(await this.read())
  }

  async put(record: BanRecord): Promise<void> {
    const write = this.queue.then(async () => {
      const all = await this.read()
      all[record.address] = record
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      const handle = await open(tmp, 'w', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(all, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, this.path)
    })
    this.queue = write.catch(() => undefined)
    return write
  }

  private async read(): Promise<Record<string, BanRecord>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, BanRecord>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error // never treat an unreadable ban list as empty
    }
  }
}
