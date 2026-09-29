import {
  type Client,
  type MPTokenIssuanceCreate,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  type SubmittableTransaction,
  type Wallet,
  convertStringToHex,
  isValidClassicAddress,
} from 'xrpl'
import { MAX_MPT_AMOUNT, toMptValue } from './amount.js'
import { type BanRecord, type BanStore, InMemoryBanStore } from './banStore.js'
import {
  HolderBannedError,
  HolderNotOptedInError,
  IssuanceConfigError,
  ValidationError,
} from './errors.js'
import { type ValidatedTx, submitAndValidate } from './submit.js'

/** Ledger flags on an MPTokenIssuance entry. */
export const IssuanceFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTCanLock: 0x02,
  lsfMPTRequireAuth: 0x04,
  lsfMPTCanEscrow: 0x08,
  lsfMPTCanTrade: 0x10,
  lsfMPTCanTransfer: 0x20,
  lsfMPTCanClawback: 0x40,
} as const

/** Ledger flags on a holder's MPToken entry. */
export const HolderFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTAuthorized: 0x02,
} as const

/**
 * Flags every issuance managed by this module must have:
 * - CanLock:     per-holder and global freeze
 * - RequireAuth: allowlist; holders must be approved by the issuer to hold/receive
 * - CanClawback: clawback and bans
 * - CanTransfer: approved holders may pay each other (a stablecoin must be transferable)
 */
export const REQUIRED_ISSUANCE_FLAGS =
  IssuanceFlags.lsfMPTCanLock |
  IssuanceFlags.lsfMPTRequireAuth |
  IssuanceFlags.lsfMPTCanClawback |
  IssuanceFlags.lsfMPTCanTransfer

/**
 * Flags this module refuses. Escrowed MPT balances cannot be clawed back while
 * escrowed, and DEX trading adds a transfer path we do not need; both would weaken
 * the "claw back any amount / ban leaves zero balance" guarantees.
 */
export const FORBIDDEN_ISSUANCE_FLAGS = IssuanceFlags.lsfMPTCanEscrow | IssuanceFlags.lsfMPTCanTrade

export interface CreateIssuanceOptions {
  /** Decimal places for display. On-ledger amounts are always integers in the smallest unit. Default 0. */
  assetScale?: number
  /** Cap on total outstanding supply, in smallest units. Default: ledger maximum (2^63 - 1). */
  maximumAmount?: bigint | string
  /** Arbitrary metadata (e.g. XLS-89 `{ ticker, name, ... }`), stored as hex-encoded JSON. Max 1024 bytes. */
  metadata?: Record<string, unknown>
}

export interface IssuerOptions {
  /** Persistent ban list. Defaults to in-memory, which is only suitable for tests. */
  banStore?: BanStore
  /** Receives one line per ledger action. Defaults to no logging. */
  log?: (message: string) => void
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  flags: number
  globallyFrozen: boolean
  outstandingAmount: bigint
  maximumAmount: bigint
  assetScale: number
}

export interface HolderState {
  holder: string
  /** False if the holder has no MPToken entry (never opted in, or deleted it). */
  optedIn: boolean
  /** Approved by the issuer (lsfMPTAuthorized). */
  authorized: boolean
  /** Individually frozen (lsfMPTLocked on the holder's MPToken). */
  frozen: boolean
  balance: bigint
}

export interface BanResult {
  holder: string
  clawedBack: bigint
  transactions: ValidatedTx[]
}

/**
 * Issuer-side controls for a single regulated MPT issuance.
 *
 * Every method that changes ledger state resolves only once the transaction is in
 * a validated ledger with `tesSUCCESS`, and throws otherwise (see errors.ts).
 * Issuer transactions are serialized within an instance, so it is safe to call
 * methods concurrently; use one instance per issuer account per process.
 */
export class MptIssuer {
  private readonly banStore: BanStore
  private readonly log: (message: string) => void
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly client: Client,
    private readonly wallet: Wallet,
    readonly issuanceId: string,
    options: IssuerOptions,
  ) {
    this.banStore = options.banStore ?? new InMemoryBanStore()
    this.log = options.log ?? (() => {})
  }

  get issuerAddress(): string {
    return this.wallet.classicAddress
  }

  /**
   * Create a new issuance from `wallet` with all compliance controls enabled.
   * Flags cannot be changed after creation, so this is the only supported way to
   * create an issuance for this module.
   */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    createOptions: CreateIssuanceOptions = {},
    options: IssuerOptions = {},
  ): Promise<MptIssuer> {
    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      Flags:
        MPTokenIssuanceCreateFlags.tfMPTCanLock |
        MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanClawback |
        MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
      AssetScale: validateAssetScale(createOptions.assetScale ?? 0),
      TransferFee: 0,
    }
    if (createOptions.maximumAmount !== undefined) {
      tx.MaximumAmount = toMptValue(createOptions.maximumAmount)
    }
    if (createOptions.metadata !== undefined) {
      const hex = convertStringToHex(JSON.stringify(createOptions.metadata))
      if (hex.length / 2 > 1024) throw new ValidationError('Issuance metadata exceeds 1024 bytes')
      tx.MPTokenMetadata = hex
    }

    const result = await submitAndValidate(client, wallet, tx)
    const issuanceId = (result.meta as { mpt_issuance_id?: string }).mpt_issuance_id
    if (!issuanceId) throw new Error(`MPTokenIssuanceCreate ${result.hash} succeeded but metadata has no mpt_issuance_id`)
    options.log?.(`created issuance ${issuanceId} (tx ${result.hash})`)

    return MptIssuer.connect(client, wallet, issuanceId, options)
  }

  /**
   * Attach to an existing issuance. Verifies on-ledger that `wallet` is the issuer
   * and that the issuance has exactly the compliance flags this module relies on.
   */
  static async connect(
    client: Client,
    wallet: Wallet,
    issuanceId: string,
    options: IssuerOptions = {},
  ): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) throw new ValidationError(`Invalid MPT issuance ID ${issuanceId}`)
    const issuer = new MptIssuer(client, wallet, issuanceId.toUpperCase(), options)
    const state = await issuer.getIssuanceState()
    if (state.issuer !== wallet.classicAddress) {
      throw new IssuanceConfigError(`Issuance ${issuanceId} is issued by ${state.issuer}, not ${wallet.classicAddress}`)
    }
    const missing = REQUIRED_ISSUANCE_FLAGS & ~state.flags
    if (missing !== 0) {
      throw new IssuanceConfigError(`Issuance ${issuanceId} is missing required flags 0x${missing.toString(16)}`)
    }
    const forbidden = FORBIDDEN_ISSUANCE_FLAGS & state.flags
    if (forbidden !== 0) {
      throw new IssuanceConfigError(`Issuance ${issuanceId} has forbidden flags 0x${forbidden.toString(16)}`)
    }
    return issuer
  }

  // ---------------------------------------------------------------------------
  // Allowlist
  // ---------------------------------------------------------------------------

  /**
   * Approve a KYC'd holder so they can hold and receive the token. The holder must
   * have opted in first (submitted MPTokenAuthorize from their own account).
   * Refuses banned addresses. No-op if already approved.
   */
  approveHolder(holder: string): Promise<ValidatedTx | undefined> {
    this.assertHolderAddress(holder)
    return this.serialize(async () => {
      await this.assertNotBanned(holder)
      const state = await this.getHolderState(holder)
      if (!state.optedIn) throw new HolderNotOptedInError(holder)
      if (state.authorized) {
        this.log(`approve ${holder}: already approved`)
        return undefined
      }
      const res = await this.submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: holder,
      })
      this.log(`approved ${holder} (tx ${res.hash})`)
      return res
    })
  }

  /**
   * Remove a holder from the allowlist. They keep any existing balance but can no
   * longer receive the token. To also remove their balance use `ban`.
   * No-op if not currently approved.
   */
  revokeApproval(holder: string): Promise<ValidatedTx | undefined> {
    this.assertHolderAddress(holder)
    return this.serialize(() => this.revokeApprovalUnqueued(holder))
  }

  // ---------------------------------------------------------------------------
  // Issuing
  // ---------------------------------------------------------------------------

  /** Send newly issued tokens to an approved holder. Amount is in the smallest unit. */
  issue(holder: string, amount: bigint | string): Promise<ValidatedTx> {
    this.assertHolderAddress(holder)
    const value = toMptValue(amount)
    return this.serialize(async () => {
      await this.assertNotBanned(holder)
      const res = await this.submit({
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: holder,
        Amount: { mpt_issuance_id: this.issuanceId, value },
      })
      this.log(`issued ${value} to ${holder} (tx ${res.hash})`)
      return res
    })
  }

  // ---------------------------------------------------------------------------
  // Clawback
  // ---------------------------------------------------------------------------

  /**
   * Claw back exactly `amount` from a holder. Works regardless of freeze or
   * approval state. Throws (without submitting) if the holder's balance is lower
   * than `amount`, so an operator typo can't silently claw back a different amount.
   */
  clawback(holder: string, amount: bigint | string): Promise<ValidatedTx> {
    this.assertHolderAddress(holder)
    const value = toMptValue(amount)
    return this.serialize(async () => {
      const state = await this.getHolderState(holder)
      if (state.balance < BigInt(value)) {
        throw new ValidationError(`Cannot claw back ${value} from ${holder}: balance is ${state.balance}`)
      }
      return this.clawbackUnqueued(holder, value)
    })
  }

  // ---------------------------------------------------------------------------
  // Freezes
  // ---------------------------------------------------------------------------

  /** Freeze one holder: they can neither send nor receive the token. */
  freezeHolder(holder: string): Promise<ValidatedTx | undefined> {
    this.assertHolderAddress(holder)
    return this.serialize(() => this.setHolderLock(holder, true))
  }

  /** Unfreeze one holder. Refuses banned holders, whose freeze is permanent. */
  unfreezeHolder(holder: string): Promise<ValidatedTx | undefined> {
    this.assertHolderAddress(holder)
    return this.serialize(async () => {
      await this.assertNotBanned(holder)
      return this.setHolderLock(holder, false)
    })
  }

  /** Freeze all movement of the token between holders. */
  freezeGlobal(): Promise<ValidatedTx | undefined> {
    return this.serialize(() => this.setGlobalLock(true))
  }

  /** Lift a global freeze. Individually frozen holders stay frozen. */
  unfreezeGlobal(): Promise<ValidatedTx | undefined> {
    return this.serialize(() => this.setGlobalLock(false))
  }

  // ---------------------------------------------------------------------------
  // Bans
  // ---------------------------------------------------------------------------

  /**
   * Ban an address permanently. In order:
   *  1. Record the ban (so the module will never approve, issue to, or unfreeze it again).
   *  2. Freeze the holder, so they cannot move funds out while the ban is in progress.
   *  3. Revoke their approval, so the ledger rejects any payment to them
   *     (the issuance requires authorization, so this holds even if they delete
   *     and recreate their MPToken entry).
   *  4. Claw back their entire balance.
   *  5. Verify the resulting on-ledger state.
   *
   * Each step is skipped if already done, so a ban that failed partway through can
   * be safely retried by calling `ban` again.
   */
  ban(holder: string, reason: string): Promise<BanResult> {
    this.assertHolderAddress(holder)
    if (!reason.trim()) throw new ValidationError('A ban reason is required')
    return this.serialize(async () => {
      const record: BanRecord = { address: holder, reason, bannedAt: new Date().toISOString() }
      await this.banStore.add(this.issuanceId, record)
      this.log(`recorded ban of ${holder}: ${reason}`)

      const transactions: ValidatedTx[] = []
      let clawedBack = 0n
      const before = await this.getHolderState(holder)
      if (before.optedIn) {
        const lock = await this.setHolderLock(holder, true)
        if (lock) transactions.push(lock)
        const revoke = await this.revokeApprovalUnqueued(holder)
        if (revoke) transactions.push(revoke)
        const { balance } = await this.getHolderState(holder)
        if (balance > 0n) {
          transactions.push(await this.clawbackUnqueued(holder, balance.toString()))
          clawedBack = balance
        }
      } else {
        this.log(`ban ${holder}: holder has no MPToken entry; nothing to do on-ledger`)
      }

      const after = await this.getHolderState(holder)
      if (after.balance !== 0n || after.authorized || (after.optedIn && !after.frozen)) {
        throw new Error(`Ban of ${holder} did not reach the expected state: ${JSON.stringify(after, bigintReplacer)}`)
      }
      return { holder, clawedBack, transactions }
    })
  }

  isBanned(holder: string): Promise<boolean> {
    return this.banStore.isBanned(this.issuanceId, holder)
  }

  listBans(): Promise<BanRecord[]> {
    return this.banStore.list(this.issuanceId)
  }

  // ---------------------------------------------------------------------------
  // Queries (always against the latest validated ledger)
  // ---------------------------------------------------------------------------

  async getIssuanceState(): Promise<IssuanceState> {
    const res = await this.client.request({
      command: 'ledger_entry',
      mpt_issuance: this.issuanceId,
      ledger_index: 'validated',
    })
    const node = res.result.node as
      | { LedgerEntryType: string; Issuer: string; Flags: number; OutstandingAmount?: string; MaximumAmount?: string; AssetScale?: number }
      | undefined
    if (!node || node.LedgerEntryType !== 'MPTokenIssuance') {
      throw new IssuanceConfigError(`Issuance ${this.issuanceId} not found`)
    }
    return {
      issuanceId: this.issuanceId,
      issuer: node.Issuer,
      flags: node.Flags,
      globallyFrozen: (node.Flags & IssuanceFlags.lsfMPTLocked) !== 0,
      outstandingAmount: BigInt(node.OutstandingAmount ?? '0'),
      maximumAmount: node.MaximumAmount ? BigInt(node.MaximumAmount) : MAX_MPT_AMOUNT,
      assetScale: node.AssetScale ?? 0,
    }
  }

  async getHolderState(holder: string): Promise<HolderState> {
    this.assertHolderAddress(holder)
    let node: { Flags: number; MPTAmount?: string } | undefined
    try {
      const res = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.issuanceId, account: holder },
        ledger_index: 'validated',
      })
      node = res.result.node as typeof node
    } catch (err) {
      if ((err as { data?: { error?: string } }).data?.error !== 'entryNotFound') throw err
    }
    if (!node) return { holder, optedIn: false, authorized: false, frozen: false, balance: 0n }
    return {
      holder,
      optedIn: true,
      authorized: (node.Flags & HolderFlags.lsfMPTAuthorized) !== 0,
      frozen: (node.Flags & HolderFlags.lsfMPTLocked) !== 0,
      balance: BigInt(node.MPTAmount ?? '0'),
    }
  }

  // ---------------------------------------------------------------------------
  // Internals. *Unqueued methods must only be called from inside serialize().
  // ---------------------------------------------------------------------------

  private async revokeApprovalUnqueued(holder: string): Promise<ValidatedTx | undefined> {
    const state = await this.getHolderState(holder)
    if (!state.authorized) {
      this.log(`revoke ${holder}: not approved`)
      return undefined
    }
    const res = await this.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    this.log(`revoked approval of ${holder} (tx ${res.hash})`)
    return res
  }

  private async clawbackUnqueued(holder: string, value: string): Promise<ValidatedTx> {
    const res = await this.submit({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value },
    })
    this.log(`clawed back ${value} from ${holder} (tx ${res.hash})`)
    return res
  }

  private async setHolderLock(holder: string, lock: boolean): Promise<ValidatedTx | undefined> {
    const state = await this.getHolderState(holder)
    if (!state.optedIn) throw new HolderNotOptedInError(holder)
    if (state.frozen === lock) {
      this.log(`${lock ? 'freeze' : 'unfreeze'} ${holder}: already ${lock ? 'frozen' : 'unfrozen'}`)
      return undefined
    }
    const res = await this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.log(`${lock ? 'froze' : 'unfroze'} ${holder} (tx ${res.hash})`)
    return res
  }

  private async setGlobalLock(lock: boolean): Promise<ValidatedTx | undefined> {
    const state = await this.getIssuanceState()
    if (state.globallyFrozen === lock) {
      this.log(`global ${lock ? 'freeze' : 'unfreeze'}: already ${lock ? 'frozen' : 'unfrozen'}`)
      return undefined
    }
    const res = await this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.log(`${lock ? 'globally froze' : 'lifted global freeze on'} ${this.issuanceId} (tx ${res.hash})`)
    return res
  }

  private submit(tx: SubmittableTransaction): Promise<ValidatedTx> {
    return submitAndValidate(this.client, this.wallet, tx)
  }

  /** Run `fn` after all previously queued issuer operations settle. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private async assertNotBanned(holder: string): Promise<void> {
    if (await this.banStore.isBanned(this.issuanceId, holder)) throw new HolderBannedError(holder)
  }

  private assertHolderAddress(holder: string): void {
    if (!isValidClassicAddress(holder)) throw new ValidationError(`Invalid classic address ${holder}`)
    if (holder === this.issuerAddress) throw new ValidationError('The issuer cannot be a holder of its own token')
  }
}

function validateAssetScale(scale: number): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 255) {
    throw new ValidationError(`assetScale must be an integer 0-255, got ${scale}`)
  }
  return scale
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
