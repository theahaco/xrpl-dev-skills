/**
 * Persistent record of banned addresses.
 *
 * Why this exists: the ledger alone cannot represent a permanent ban. A banned
 * holder whose balance is zero can delete their MPToken entry and create a
 * fresh one; the fresh entry is indistinguishable on-ledger from an account
 * that was never approved. Require Auth stops that fresh entry from receiving
 * tokens, but nothing on-ledger stops an operator from approving it again.
 * The issuer module consults this registry before every approval and issuance.
 *
 * Production deployments should implement `BanRegistry` on top of the
 * backend's transactional database. `FileBanRegistry` is suitable for the demo
 * and for single-process tooling.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BanRecord {
  readonly issuanceId: string
  readonly address: string
  readonly reason: string
  /** ISO-8601 timestamp of when the ban was recorded. */
  readonly bannedAt: string
}

export interface BanRegistry {
  isBanned(issuanceId: string, address: string): Promise<boolean>
  /** Must be durable (persisted) before it resolves. Recording an existing ban again must be a no-op. */
  recordBan(record: BanRecord): Promise<void>
  getBan(issuanceId: string, address: string): Promise<BanRecord | undefined>
}

interface BanFile {
  readonly version: 1
  readonly bans: BanRecord[]
}

/**
 * JSON-file-backed registry. Writes are atomic (write to a temp file, then rename)
 * and serialized within the process. Not safe for multiple processes sharing one file.
 */
export class FileBanRegistry implements BanRegistry {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async isBanned(issuanceId: string, address: string): Promise<boolean> {
    return (await this.getBan(issuanceId, address)) !== undefined
  }

  async getBan(issuanceId: string, address: string): Promise<BanRecord | undefined> {
    const file = await this.load()
    return file.bans.find((b) => b.issuanceId === issuanceId && b.address === address)
  }

  recordBan(record: BanRecord): Promise<void> {
    const run = this.writeChain.then(async () => {
      const file = await this.load()
      if (file.bans.some((b) => b.issuanceId === record.issuanceId && b.address === record.address)) {
        return
      }
      const next: BanFile = { version: 1, bans: [...file.bans, record] }
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flush: true })
      await rename(tmp, this.path)
    })
    // Keep the chain alive even if this write fails; the caller still sees the rejection.
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async load(): Promise<BanFile> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, bans: [] }
      }
      throw err
    }
    const parsed = JSON.parse(raw) as Partial<BanFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.bans)) {
      // Fail closed: an unreadable ban list must never be treated as "nobody is banned".
      throw new Error(`Ban registry at ${this.path} is malformed`)
    }
    return { version: 1, bans: parsed.bans }
  }
}
