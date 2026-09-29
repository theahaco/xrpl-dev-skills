import {
  type Client,
  type LedgerEntry,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type TxResponse,
  type Wallet,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  XrplError,
} from 'xrpl'

import { fromRawAmount, toRawAmount } from './amounts.js'
import type { BanRegistry } from './banRegistry.js'
import {
  HolderBannedError,
  HolderFrozenError,
  HolderNotOptedInError,
  InsufficientBalanceError,
  IssuanceConfigError,
  MptIssuerError,
  StateVerificationError,
  TokenFrozenError,
  TransactionFailedError,
} from './errors.js'

type MPTokenIssuanceEntry = LedgerEntry.MPTokenIssuance
type MPTokenEntry = LedgerEntry.MPToken

/** MPTokenIssuance ledger flags (XLS-33). */
export const IssuanceFlag = {
  Locked: 0x01,
  CanLock: 0x02,
  RequireAuth: 0x04,
  CanEscrow: 0x08,
  CanTrade: 0x10,
  CanTransfer: 0x20,
  CanClawback: 0x40,
  CanHoldConfidentialBalance: 0x80,
} as const

/** MPToken (per-holder) ledger flags (XLS-33). Not exported by xrpl.js. */
export const HoldingFlag = {
  Locked: 0x01,
  Authorized: 0x02,
} as const

/** Capabilities every issuance managed by this module must have. */
const REQUIRED_FLAGS = IssuanceFlag.CanLock | IssuanceFlag.RequireAuth | IssuanceFlag.CanClawback

/**
 * Capabilities that must stay off. Escrowed, DEX/AMM-held and confidential
 * balances are held outside the holder's plain MPToken balance, so they could
 * escape a Clawback or survive a ban.
 */
const FORBIDDEN_FLAGS =
  IssuanceFlag.CanEscrow | IssuanceFlag.CanTrade | IssuanceFlag.CanHoldConfidentialBalance

/** Every capability bit that DynamicMPT's ImmutableFlags can pin. */
const ALL_CAPABILITY_FLAGS =
  IssuanceFlag.CanLock |
  IssuanceFlag.RequireAuth |
  IssuanceFlag.CanEscrow |
  IssuanceFlag.CanTrade |
  IssuanceFlag.CanTransfer |
  IssuanceFlag.CanClawback |
  IssuanceFlag.CanHoldConfidentialBalance

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

const silentLogger: Logger = { info: () => {}, warn: () => {} }

export interface CreateIssuanceOptions {
  /** Decimal places for display amounts. Immutable after creation. Default 0. */
  assetScale?: number
  /** Supply cap, in display units. Default: protocol maximum. */
  maximumAmount?: string
  /** Allow holder-to-holder transfers. Default true (needed for a payment token). */
  allowHolderTransfers?: boolean
  /** XLS-89 metadata. */
  metadata?: MPTokenMetadata
  logger?: Logger
}

export interface IssuerContext {
  client: Client
  /** The issuer's wallet. Only this process should submit from this account. */
  wallet: Wallet
  issuanceId: string
  banRegistry: BanRegistry
  logger?: Logger
}

export interface IssuanceStatus {
  issuanceId: string
  issuer: string
  assetScale: number
  outstanding: string
  globallyFrozen: boolean
  flags: {
    canLock: boolean
    requireAuth: boolean
    canClawback: boolean
    canTransfer: boolean
    canEscrow: boolean
    canTrade: boolean
  }
}

export interface HolderStatus {
  address: string
  /** Whether the holder has an MPToken (has opted in). */
  optedIn: boolean
  /** Balance in display units. */
  balance: string
  /** Balance in raw ledger units. */
  rawBalance: bigint
  approved: boolean
  frozen: boolean
  banned: boolean
}

export interface BanResult {
  address: string
  /** Amount clawed back as part of the ban, in display units. */
  clawedBack: string
  transactions: string[]
}

/**
 * Issuer-side compliance controls for a single MPT issuance.
 *
 * All issuer transactions from one instance are serialized, so concurrent
 * calls never race on the account Sequence. Run at most one instance (one
 * process) per issuer account, or use Tickets if you need more.
 *
 * Every mutating method waits for the transaction to be in a validated ledger
 * and throws {@link TransactionFailedError} if the result is not tesSUCCESS.
 */
export class MptIssuer {
  readonly client: Client
  readonly issuanceId: string
  readonly assetScale: number
  private readonly wallet: Wallet
  private readonly bans: BanRegistry
  private readonly log: Logger
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(ctx: IssuerContext, assetScale: number) {
    this.client = ctx.client
    this.wallet = ctx.wallet
    this.issuanceId = ctx.issuanceId
    this.bans = ctx.banRegistry
    this.log = ctx.logger ?? silentLogger
    this.assetScale = assetScale
  }

  get issuerAddress(): string {
    return this.wallet.classicAddress
  }

  /**
   * Create a new issuance with allowlisting, locking and clawback enabled and
   * returns its MPTokenIssuanceID. These capability flags cannot be changed
   * afterwards; if the DynamicMPT amendment is active they are additionally
   * pinned with ImmutableFlags so they can never be mutated.
   */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    options: CreateIssuanceOptions = {},
  ): Promise<string> {
    const log = options.logger ?? silentLogger
    const assetScale = options.assetScale ?? 0
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
      throw new RangeError('assetScale must be an integer between 0 and 255')
    }

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (options.allowHolderTransfers ?? true) {
      flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer
    }

    const tx: SubmittableTransaction = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: assetScale,
      Flags: flags,
    }
    if (options.maximumAmount !== undefined) {
      tx.MaximumAmount = toRawAmount(options.maximumAmount, assetScale).toString()
    }
    if (options.metadata !== undefined) {
      tx.MPTokenMetadata = encodeMPTokenMetadata(options.metadata)
    }
    if (await isAmendmentEnabled(client, 'DynamicMPT')) {
      tx.ImmutableFlags = ALL_CAPABILITY_FLAGS
    }

    const response = await submitAsIssuer(client, wallet, tx)
    const meta = response.result.meta
    const issuanceId =
      typeof meta === 'object' && 'mpt_issuance_id' in meta ? meta.mpt_issuance_id : undefined
    if (issuanceId === undefined) {
      throw new MptIssuerError(`MPTokenIssuanceCreate ${response.result.hash} returned no mpt_issuance_id`)
    }
    log.info('Created MPT issuance', { issuanceId, tx: response.result.hash })
    return issuanceId
  }

  /**
   * Bind to an existing issuance, verifying it is owned by `wallet` and has the
   * capabilities every compliance control depends on.
   */
  static async load(ctx: IssuerContext): Promise<MptIssuer> {
    const issuance = await fetchIssuance(ctx.client, ctx.issuanceId)
    if (issuance.Issuer !== ctx.wallet.classicAddress) {
      throw new IssuanceConfigError(
        `Issuance ${ctx.issuanceId} belongs to ${issuance.Issuer}, not ${ctx.wallet.classicAddress}`,
      )
    }
    if ((issuance.Flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS) {
      throw new IssuanceConfigError(
        `Issuance ${ctx.issuanceId} lacks required flags (needs CanLock, RequireAuth, CanClawback)`,
      )
    }
    if ((issuance.Flags & FORBIDDEN_FLAGS) !== 0) {
      throw new IssuanceConfigError(
        `Issuance ${ctx.issuanceId} enables escrow, trading or confidential balances, which can put funds out of reach of clawback`,
      )
    }
    if (issuance.DomainID !== undefined) {
      throw new IssuanceConfigError(
        `Issuance ${ctx.issuanceId} has a DomainID, which admits holders without issuer approval`,
      )
    }
    return new MptIssuer(ctx, issuance.AssetScale ?? 0)
  }

  // ---------------------------------------------------------------- reads

  async getIssuanceStatus(): Promise<IssuanceStatus> {
    const i = await fetchIssuance(this.client, this.issuanceId)
    const has = (f: number): boolean => (i.Flags & f) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: i.Issuer,
      assetScale: i.AssetScale ?? 0,
      outstanding: fromRawAmount(BigInt(i.OutstandingAmount), i.AssetScale ?? 0),
      globallyFrozen: has(IssuanceFlag.Locked),
      flags: {
        canLock: has(IssuanceFlag.CanLock),
        requireAuth: has(IssuanceFlag.RequireAuth),
        canClawback: has(IssuanceFlag.CanClawback),
        canTransfer: has(IssuanceFlag.CanTransfer),
        canEscrow: has(IssuanceFlag.CanEscrow),
        canTrade: has(IssuanceFlag.CanTrade),
      },
    }
  }

  /** Holder state as of the latest validated ledger. */
  async getHolderStatus(address: string): Promise<HolderStatus> {
    this.assertHolderAddress(address)
    const [holding, banned] = await Promise.all([
      this.fetchHolding(address),
      this.bans.isBanned(this.issuanceId, address),
    ])
    const rawBalance = holding ? BigInt(holding.MPTAmount ?? '0') : 0n
    return {
      address,
      optedIn: holding !== null,
      balance: fromRawAmount(rawBalance, this.assetScale),
      rawBalance,
      approved: holding !== null && (holding.Flags & HoldingFlag.Authorized) !== 0,
      frozen: holding !== null && (holding.Flags & HoldingFlag.Locked) !== 0,
      banned,
    }
  }

  async isBanned(address: string): Promise<boolean> {
    return this.bans.isBanned(this.issuanceId, address)
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Approve a KYC'd holder. The holder must first opt in by submitting their
   * own MPTokenAuthorize. No-op if already approved. Refuses banned addresses.
   */
  async approveHolder(address: string): Promise<string | null> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      await this.assertNotBanned(address)
      const holding = await this.fetchHolding(address)
      if (holding === null) throw new HolderNotOptedInError(address)
      if ((holding.Flags & HoldingFlag.Authorized) !== 0) return null
      const hash = await this.submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
      this.log.info('Approved holder', { address, tx: hash })
      return hash
    })
  }

  /**
   * Remove a holder's approval. They can no longer send or receive the token,
   * but keep any balance they hold. Use {@link ban} to also remove the balance.
   */
  async revokeApproval(address: string): Promise<string | null> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      return this.revokeApprovalUnlocked(address)
    })
  }

  // ------------------------------------------------------------- issuance

  /**
   * Send newly issued tokens from the issuer to an approved holder.
   *
   * MPT locks only block holder-to-holder transfers; the ledger still accepts
   * issuer payments to a locked holder or during a global lock. This method
   * therefore refuses to pay frozen holders or while the token is frozen.
   * Transactions must go through this module for that guarantee to hold.
   */
  async issue(address: string, amount: string): Promise<string> {
    const raw = toRawAmount(amount, this.assetScale)
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      await this.assertNotBanned(address)
      const [issuance, holding] = await Promise.all([
        fetchIssuance(this.client, this.issuanceId),
        this.fetchHolding(address),
      ])
      if ((issuance.Flags & IssuanceFlag.Locked) !== 0) throw new TokenFrozenError(this.issuanceId)
      if (holding === null) throw new HolderNotOptedInError(address)
      if ((holding.Flags & HoldingFlag.Locked) !== 0) throw new HolderFrozenError(address)
      const hash = await this.submit({
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: raw.toString() },
      })
      this.log.info('Issued tokens', { address, amount, tx: hash })
      return hash
    })
  }

  // ------------------------------------------------------------- clawback

  /** Claw back exactly `amount` from a holder. Fails if their balance is lower. */
  async clawback(address: string, amount: string): Promise<string> {
    const raw = toRawAmount(amount, this.assetScale)
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      const balance = await this.rawBalance(address)
      if (balance < raw) {
        throw new InsufficientBalanceError(address, amount, fromRawAmount(balance, this.assetScale))
      }
      return this.clawbackUnlocked(address, raw)
    })
  }

  /** Claw back a holder's entire balance. Returns the amount recovered. */
  async clawbackAll(address: string): Promise<string> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      const balance = await this.rawBalance(address)
      if (balance > 0n) await this.clawbackUnlocked(address, balance)
      return fromRawAmount(balance, this.assetScale)
    })
  }

  // --------------------------------------------------------------- freeze

  /**
   * Stop a single holder from sending or receiving the token. Idempotent.
   *
   * On ledger this blocks all transfers to and from other holders. The XRPL
   * still lets a locked holder pay the token back to the issuer (a redemption,
   * which burns it), so off-ledger redemption processing must check
   * {@link getHolderStatus} and refuse to pay out for frozen or banned holders.
   */
  async freezeHolder(address: string): Promise<string | null> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      return this.setHolderLock(address, true)
    })
  }

  async unfreezeHolder(address: string): Promise<string | null> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      return this.setHolderLock(address, false)
    })
  }

  /**
   * Halt all movement of the token: the ledger blocks every holder-to-holder
   * transfer, and {@link issue} refuses to pay out. As with holder freezes,
   * holders can still redeem to the issuer on ledger.
   */
  async freezeAll(): Promise<string | null> {
    return this.exclusive(() => this.setGlobalLock(true))
  }

  async unfreezeAll(): Promise<string | null> {
    return this.exclusive(() => this.setGlobalLock(false))
  }

  // ------------------------------------------------------------------ ban

  /**
   * Permanently ban an address:
   *   1. record the ban durably (blocks future approve/issue calls),
   *   2. freeze the holding so nothing can move in or out meanwhile,
   *   3. claw back the entire balance,
   *   4. revoke approval, so the ledger itself rejects future transfers in.
   * The holding stays frozen as defence in depth. Each step is idempotent, so
   * a failed ban can be retried safely; the final state is verified.
   */
  async ban(address: string, reason: string): Promise<BanResult> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      await this.bans.ban({
        issuanceId: this.issuanceId,
        address,
        reason,
        bannedAt: new Date().toISOString(),
      })
      this.log.warn('Ban recorded', { address, reason })

      const transactions: string[] = []
      let clawed = 0n
      if ((await this.fetchHolding(address)) !== null) {
        const lockTx = await this.setHolderLock(address, true)
        if (lockTx) transactions.push(lockTx)

        const balance = await this.rawBalance(address)
        if (balance > 0n) {
          transactions.push(await this.clawbackUnlocked(address, balance))
          clawed = balance
        }

        const revokeTx = await this.revokeApprovalUnlocked(address)
        if (revokeTx) transactions.push(revokeTx)
      }

      const after = await this.fetchHolding(address)
      if (after !== null) {
        if (BigInt(after.MPTAmount ?? '0') !== 0n) {
          throw new StateVerificationError(`Ban of ${address}: balance is ${after.MPTAmount}, expected 0`)
        }
        if ((after.Flags & HoldingFlag.Authorized) !== 0) {
          throw new StateVerificationError(`Ban of ${address}: holder is still authorized`)
        }
      }
      const clawedBack = fromRawAmount(clawed, this.assetScale)
      this.log.warn('Holder banned', { address, clawedBack, transactions })
      return { address, clawedBack, transactions }
    })
  }

  // ------------------------------------------------------------ internals

  /** Run `fn` after every previously queued issuer operation has settled. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async submit(tx: SubmittableTransaction): Promise<string> {
    return (await submitAsIssuer(this.client, this.wallet, tx)).result.hash
  }

  private async clawbackUnlocked(address: string, raw: bigint): Promise<string> {
    const hash = await this.submit({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: raw.toString() },
    })
    this.log.info('Clawed back tokens', {
      address,
      amount: fromRawAmount(raw, this.assetScale),
      tx: hash,
    })
    return hash
  }

  private async revokeApprovalUnlocked(address: string): Promise<string | null> {
    const holding = await this.fetchHolding(address)
    if (holding === null || (holding.Flags & HoldingFlag.Authorized) === 0) return null
    const hash = await this.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    this.log.info('Revoked holder approval', { address, tx: hash })
    return hash
  }

  private async setHolderLock(address: string, locked: boolean): Promise<string | null> {
    const holding = await this.fetchHolding(address)
    if (holding === null) throw new HolderNotOptedInError(address)
    if (((holding.Flags & HoldingFlag.Locked) !== 0) === locked) return null
    const hash = await this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: locked ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.log.info(locked ? 'Froze holder' : 'Unfroze holder', { address, tx: hash })
    return hash
  }

  private async setGlobalLock(locked: boolean): Promise<string | null> {
    const issuance = await fetchIssuance(this.client, this.issuanceId)
    if (((issuance.Flags & IssuanceFlag.Locked) !== 0) === locked) return null
    const hash = await this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: locked ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.log.warn(locked ? 'Global freeze enabled' : 'Global freeze lifted', { tx: hash })
    return hash
  }

  private async rawBalance(address: string): Promise<bigint> {
    const holding = await this.fetchHolding(address)
    return holding ? BigInt(holding.MPTAmount ?? '0') : 0n
  }

  private async fetchHolding(address: string): Promise<MPTokenEntry | null> {
    try {
      const res = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.issuanceId, account: address },
        ledger_index: 'validated',
      })
      // xrpl.js omits MPToken from its LedgerEntry union.
      return res.result.node as unknown as MPTokenEntry
    } catch (err) {
      if (isEntryNotFound(err)) return null
      throw err
    }
  }

  private async assertNotBanned(address: string): Promise<void> {
    if (await this.bans.isBanned(this.issuanceId, address)) throw new HolderBannedError(address)
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) {
      throw new MptIssuerError(`"${address}" is not a valid classic address`)
    }
    if (address === this.issuerAddress) {
      throw new MptIssuerError('The issuer cannot be a holder of its own token')
    }
  }
}

/**
 * Sign, submit and wait for validation. Throws unless the validated result is
 * tesSUCCESS.
 */
export async function submitAsIssuer(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<TxResponse> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  const result = typeof meta === 'object' ? meta.TransactionResult : 'unknown'
  if (response.result.validated !== true || result !== 'tesSUCCESS') {
    throw new TransactionFailedError(tx.TransactionType, result, response.result.hash)
  }
  return response
}

async function fetchIssuance(client: Client, issuanceId: string): Promise<MPTokenIssuanceEntry> {
  try {
    const res = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    return res.result.node as MPTokenIssuanceEntry
  } catch (err) {
    if (isEntryNotFound(err)) {
      throw new IssuanceConfigError(`MPT issuance ${issuanceId} not found in the validated ledger`)
    }
    throw err
  }
}

async function isAmendmentEnabled(client: Client, name: string): Promise<boolean> {
  const res = await client.request({ command: 'feature' })
  return Object.values(res.result.features).some((f) => f.name === name && f.enabled)
}

function isEntryNotFound(err: unknown): boolean {
  if (!(err instanceof XrplError)) return false
  const data = err.data as { error?: string } | undefined
  return data?.error === 'entryNotFound' || err.message === 'entryNotFound'
}
