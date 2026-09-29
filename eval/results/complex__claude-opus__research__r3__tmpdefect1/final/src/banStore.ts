/**
 * Durable record of banned addresses.
 *
 * On ledger a banned holder ends up unauthorized, locked and with a zero
 * balance, which already stops them receiving the token. The ledger cannot,
 * however, tell "banned" apart from "not yet approved": nothing there stops an
 * operator from re-approving a banned address by mistake. The ban store is
 * that record, and the issuer module checks it before every authorization
 * and payment.
 *
 * Production deployments should back this with the same database the KYC
 * system uses. `InMemoryBanStore` is only suitable for tests and demos.
 */
export interface BanRecord {
  address: string
  reason: string
  bannedAt: string
}

export interface BanStore {
  isBanned(address: string): Promise<boolean>
  /** Must be idempotent: banning an already-banned address keeps the original record. */
  add(record: BanRecord): Promise<void>
  get(address: string): Promise<BanRecord | undefined>
  list(): Promise<BanRecord[]>
}

export class InMemoryBanStore implements BanStore {
  readonly #records = new Map<string, BanRecord>()

  async isBanned(address: string): Promise<boolean> {
    return this.#records.has(address)
  }

  async add(record: BanRecord): Promise<void> {
    if (!this.#records.has(record.address)) {
      this.#records.set(record.address, { ...record })
    }
  }

  async get(address: string): Promise<BanRecord | undefined> {
    const record = this.#records.get(address)
    return record === undefined ? undefined : { ...record }
  }

  async list(): Promise<BanRecord[]> {
    return [...this.#records.values()].map((record) => ({ ...record }))
  }
}
