import {
  type Client,
  type MPTokenMetadata,
  type TransactionMetadata,
  type Wallet,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  XrplError,
  encodeMPTokenMetadata,
  isValidClassicAddress,
} from 'xrpl'

import { fromBaseUnits, toBaseUnits } from './amount.js'
import type { BanRecord, BanRegistry } from './ban-registry.js'
import { IssuerError } from './errors.js'
import { type Logger, silentLogger } from './logger.js'
import { type SubmitterOptions, TransactionSubmitter } from './submitter.js'

/** MPTokenIssuance ledger flags. */
const lsfIssuanceLocked = 0x01
const lsfMPTCanLock = 0x02
const lsfMPTRequireAuth = 0x04
const lsfMPTCanEscrow = 0x08
const lsfMPTCanTrade = 0x10
const lsfMPTCanTransfer = 0x20
const lsfMPTCanClawback = 0x40
const lsfMPTCanHoldConfidentialBalance = 0x80

/** MPToken (per-holder) ledger flags. */
const lsfHolderLocked = 0x01
const lsfHolderAuthorized = 0x02

/** Maximum AssetScale accepted by this module (keeps every amount exact in 63 bits). */
const MAX_ASSET_SCALE = 18

export interface IssuanceConfig {
  /** Number of decimal places; amounts passed to this module are decimal strings at this scale. */
  assetScale: number
  /** Optional hard cap on total supply, as a decimal token amount. */
  maximumAmount?: string
  /**
   * Allow approved holders to send the token to each other. When false the
   * token can only move between the issuer and holders.
   */
  transferable?: boolean
  /** XLS-89 token metadata (ticker, name, issuer_name, ...). */
  metadata?: MPTokenMetadata
}

export interface MptIssuerOptions {
  banRegistry: BanRegistry
  logger?: Logger
  submitter?: SubmitterOptions
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  outstanding: string
  maximumAmount: string | undefined
  globallyFrozen: boolean
  capabilities: {
    canLock: boolean
    requireAuth: boolean
    canTransfer: boolean
    canClawback: boolean
    canEscrow: boolean
    canTrade: boolean
    canHoldConfidentialBalance: boolean
  }
  domainId: string | undefined
}

export interface HolderState {
  address: string
  /** The holder has created its MPToken entry for this issuance. */
  optedIn: boolean
  /** Approved by the issuer (on the allowlist). */
  authorized: boolean
  /** Individually frozen. Does not reflect a global freeze. */
  frozen: boolean
  balance: string
  /** Amount held in escrow; always "0" for issuances created by this module. */
  lockedAmount: string
  ban: BanRecord | undefined
}

export interface TxOutcome {
  /** null when the ledger was already in the requested state and nothing was submitted. */
  txHash: string | null
}

export interface TransferOutcome {
  txHash: string
  amount: string
  holderBalance: string
}

export interface BanOutcome {
  ban: BanRecord
  txHashes: string[]
  clawedBack: string
}

const REQUIRED_FLAGS: ReadonlyArray<[number, string]> = [
  [lsfMPTRequireAuth, 'RequireAuth (allowlist)'],
  [lsfMPTCanClawback, 'CanClawback'],
  [lsfMPTCanLock, 'CanLock (freezes)'],
]

// Each of these lets balances sit somewhere other than the holder's own
// MPToken balance (escrows, DEX/AMM positions, encrypted balances), where
// clawback, bans and freezes would not reliably reach them.
const FORBIDDEN_FLAGS: ReadonlyArray<[number, string]> = [
  [lsfMPTCanEscrow, 'CanEscrow'],
  [lsfMPTCanTrade, 'CanTrade'],
  [lsfMPTCanHoldConfidentialBalance, 'CanHoldConfidentialBalance'],
]

/**
 * Issuer-side controls for a single regulated Multi-Purpose Token issuance.
 *
 * Every state-changing method submits from the issuer account, waits for the
 * transaction to be validated and throws unless it succeeded. Transactions
 * are serialised, so the instance is safe to share across concurrent callers
 * in one process. Do not run two instances for the same issuer account at the
 * same time.
 */
export class MptIssuer {
  readonly issuanceId: string
  readonly assetScale: number
  private readonly client: Client
  private readonly wallet: Wallet
  private readonly bans: BanRegistry
  private readonly logger: Logger
  private readonly submitter: TransactionSubmitter

  private constructor(client: Client, wallet: Wallet, issuanceId: string, assetScale: number, options: MptIssuerOptions) {
    this.client = client
    this.wallet = wallet
    this.issuanceId = issuanceId
    this.assetScale = assetScale
    this.bans = options.banRegistry
    this.logger = options.logger ?? silentLogger
    this.submitter = new TransactionSubmitter(client, wallet, { logger: this.logger, ...options.submitter })
  }

  get issuerAddress(): string {
    return this.wallet.classicAddress
  }

  /**
   * Creates a new issuance with the allowlist, clawback and freeze controls
   * enabled. These capabilities are fixed at creation and cannot be removed.
   */
  static async createIssuance(client: Client, wallet: Wallet, config: IssuanceConfig, options: MptIssuerOptions): Promise<MptIssuer> {
    const { assetScale } = config
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_ASSET_SCALE) {
      throw new IssuerError('INVALID_AMOUNT', `assetScale must be an integer between 0 and ${MAX_ASSET_SCALE}`)
    }
    let flags = MPTokenIssuanceCreateFlags.tfMPTRequireAuth | MPTokenIssuanceCreateFlags.tfMPTCanClawback | MPTokenIssuanceCreateFlags.tfMPTCanLock
    if (config.transferable ?? true) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const submitter = new TransactionSubmitter(client, wallet, { logger: options.logger ?? silentLogger, ...options.submitter })
    const result = await submitter.submit({
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: assetScale,
      Flags: flags,
      ...(config.maximumAmount !== undefined && { MaximumAmount: toBaseUnits(config.maximumAmount, assetScale).toString() }),
      ...(config.metadata !== undefined && { MPTokenMetadata: encodeMPTokenMetadata(config.metadata) }),
    })
    const issuanceId = (result.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    if (issuanceId === undefined) {
      throw new IssuerError('ISSUANCE_NOT_FOUND', `MPTokenIssuanceCreate ${result.hash} succeeded but returned no mpt_issuance_id`)
    }
    options.logger?.info('issuance.created', { issuanceId, txHash: result.hash })
    return MptIssuer.connect(client, wallet, issuanceId, options)
  }

  /**
   * Attaches to an existing issuance, verifying it belongs to the wallet and
   * that its on-ledger configuration supports every compliance control.
   */
  static async connect(client: Client, wallet: Wallet, issuanceId: string, options: MptIssuerOptions): Promise<MptIssuer> {
    const issuance = await fetchIssuance(client, issuanceId)
    if (issuance.Issuer !== wallet.classicAddress) {
      throw new IssuerError('ISSUANCE_MISCONFIGURED', `Issuance ${issuanceId} is issued by ${issuance.Issuer}, not ${wallet.classicAddress}`)
    }
    const problems = [
      ...REQUIRED_FLAGS.filter(([flag]) => (issuance.Flags & flag) === 0).map(([, name]) => `missing ${name}`),
      ...FORBIDDEN_FLAGS.filter(([flag]) => (issuance.Flags & flag) !== 0).map(([, name]) => `has ${name} enabled`),
      ...(issuance.DomainID !== undefined ? ['has a DomainID, which admits holders outside the allowlist'] : []),
    ]
    if (problems.length > 0) {
      throw new IssuerError('ISSUANCE_MISCONFIGURED', `Issuance ${issuanceId} cannot enforce compliance controls: ${problems.join('; ')}`)
    }
    return new MptIssuer(client, wallet, issuanceId, issuance.AssetScale ?? 0, options)
  }

  // ---------------------------------------------------------------- reads

  async getIssuanceState(): Promise<IssuanceState> {
    const issuance = await fetchIssuance(this.client, this.issuanceId)
    const has = (flag: number): boolean => (issuance.Flags & flag) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: issuance.Issuer,
      assetScale: this.assetScale,
      outstanding: this.format(BigInt(issuance.OutstandingAmount ?? '0')),
      maximumAmount: issuance.MaximumAmount !== undefined ? this.format(BigInt(issuance.MaximumAmount)) : undefined,
      globallyFrozen: has(lsfIssuanceLocked),
      capabilities: {
        canLock: has(lsfMPTCanLock),
        requireAuth: has(lsfMPTRequireAuth),
        canTransfer: has(lsfMPTCanTransfer),
        canClawback: has(lsfMPTCanClawback),
        canEscrow: has(lsfMPTCanEscrow),
        canTrade: has(lsfMPTCanTrade),
        canHoldConfidentialBalance: has(lsfMPTCanHoldConfidentialBalance),
      },
      domainId: issuance.DomainID,
    }
  }

  async getHolderState(holder: string): Promise<HolderState> {
    this.assertHolderAddress(holder)
    const [token, ban] = await Promise.all([this.fetchHolderToken(holder), this.bans.get(holder)])
    return {
      address: holder,
      optedIn: token !== undefined,
      authorized: token !== undefined && (token.Flags & lsfHolderAuthorized) !== 0,
      frozen: token !== undefined && (token.Flags & lsfHolderLocked) !== 0,
      balance: this.format(BigInt(token?.MPTAmount ?? '0')),
      lockedAmount: this.format(BigInt(token?.LockedAmount ?? '0')),
      ban,
    }
  }

  async isBanned(holder: string): Promise<boolean> {
    return (await this.bans.get(holder)) !== undefined
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Approves a holder (adds them to the allowlist). Call only after KYC has
   * passed. The holder must first opt in by submitting their own
   * MPTokenAuthorize for this issuance. Banned addresses are always refused.
   */
  async authorizeHolder(holder: string): Promise<TxOutcome> {
    await this.assertNotBanned(holder)
    const state = await this.getHolderState(holder)
    if (!state.optedIn) {
      throw new IssuerError('HOLDER_NOT_OPTED_IN', `${holder} has not opted in to issuance ${this.issuanceId}`)
    }
    if (state.authorized) return { txHash: null }
    const result = await this.submitter.submit(
      {
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: holder,
      },
      // Re-checked in the queue so a ban recorded meanwhile always wins.
      { precheck: () => this.assertNotBanned(holder) },
    )
    this.logger.info('holder.authorized', { issuanceId: this.issuanceId, holder, txHash: result.hash })
    return { txHash: result.hash }
  }

  /** Removes a holder from the allowlist. Their existing balance is untouched but can no longer move. */
  async deauthorizeHolder(holder: string): Promise<TxOutcome> {
    const state = await this.getHolderState(holder)
    if (!state.authorized) return { txHash: null }
    const result = await this.submitter.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    this.logger.info('holder.deauthorized', { issuanceId: this.issuanceId, holder, txHash: result.hash })
    return { txHash: result.hash }
  }

  // ------------------------------------------------------ issue / clawback

  /**
   * Sends newly issued tokens from the issuer to an approved holder.
   *
   * The ledger only stops holder-to-holder transfers while a holder or the
   * whole token is frozen; it still lets the issuer pay them. This method is
   * what enforces "a frozen holder cannot receive" for issuer payments, so all
   * issuance must go through it.
   */
  async issue(holder: string, amount: string): Promise<TransferOutcome> {
    const units = toBaseUnits(amount, this.assetScale)
    this.assertHolderAddress(holder)
    // Checked inside the submission queue so a concurrent freeze or ban
    // submitted through this instance cannot slip in between check and payment.
    const precheck = async (): Promise<void> => {
      await this.assertNotBanned(holder)
      const [state, issuance] = await Promise.all([this.getHolderState(holder), this.getIssuanceState()])
      if (!state.optedIn) throw new IssuerError('HOLDER_NOT_OPTED_IN', `${holder} has not opted in to issuance ${this.issuanceId}`)
      if (!state.authorized) throw new IssuerError('HOLDER_NOT_AUTHORIZED', `${holder} is not approved to hold issuance ${this.issuanceId}`)
      if (state.frozen) throw new IssuerError('HOLDER_FROZEN', `${holder} is frozen and cannot receive issuance ${this.issuanceId}`)
      if (issuance.globallyFrozen) throw new IssuerError('TOKEN_FROZEN', `Issuance ${this.issuanceId} is globally frozen`)
    }
    const result = await this.submitter.submit(
      {
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: holder,
        Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
      },
      { precheck },
    )
    const delivered = this.balanceChange(result.meta, holder)
    if (delivered !== units) {
      // Cannot happen without partial payments, but never report an amount the ledger did not move.
      throw new IssuerError('TX_FAILED', `Payment ${result.hash} delivered ${delivered} base units, expected ${units}`)
    }
    const holderBalance = await this.holderBalance(holder)
    this.logger.info('tokens.issued', { issuanceId: this.issuanceId, holder, amount, txHash: result.hash })
    return { txHash: result.hash, amount: this.format(delivered), holderBalance: this.format(holderBalance) }
  }

  /**
   * Claws back exactly `amount` from a holder. Refuses (rather than taking
   * less) if the holder's balance is smaller than the requested amount.
   */
  async clawback(holder: string, amount: string): Promise<TransferOutcome> {
    const units = toBaseUnits(amount, this.assetScale)
    this.assertHolderAddress(holder)
    const balance = await this.holderBalance(holder)
    if (balance < units) {
      throw new IssuerError('INSUFFICIENT_BALANCE', `${holder} holds ${this.format(balance)}, cannot claw back ${amount}`)
    }
    return this.submitClawback(holder, units)
  }

  /** Claws back a holder's entire balance. Returns null if they hold nothing. */
  async clawbackAll(holder: string): Promise<TransferOutcome | null> {
    this.assertHolderAddress(holder)
    const balance = await this.holderBalance(holder)
    return balance > 0n ? this.submitClawback(holder, balance) : null
  }

  private async submitClawback(holder: string, units: bigint): Promise<TransferOutcome> {
    const result = await this.submitter.submit({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
    })
    // The ledger silently caps clawback at the balance, so report what actually moved.
    const clawed = -this.balanceChange(result.meta, holder)
    const holderBalance = await this.holderBalance(holder)
    const fields = { issuanceId: this.issuanceId, holder, requested: this.format(units), clawedBack: this.format(clawed), txHash: result.hash }
    if (clawed !== units) this.logger.warn('tokens.clawback_short', fields)
    else this.logger.info('tokens.clawed_back', fields)
    return { txHash: result.hash, amount: this.format(clawed), holderBalance: this.format(holderBalance) }
  }

  // --------------------------------------------------------------- freezes

  /**
   * Freezes one holder until unfrozen. The ledger then rejects every transfer
   * to or from them except a payment back to the issuer (a redemption, which
   * the protocol always permits), and issue() refuses to pay them.
   */
  async freezeHolder(holder: string): Promise<TxOutcome> {
    return this.setHolderLock(holder, true)
  }

  async unfreezeHolder(holder: string): Promise<TxOutcome> {
    return this.setHolderLock(holder, false)
  }

  /**
   * Freezes the whole token. The ledger rejects every transfer between
   * holders; payments back to the issuer remain possible, and issue()
   * refuses to pay anyone until the freeze is lifted. Clawback and bans still
   * work while frozen.
   */
  async freezeAll(): Promise<TxOutcome> {
    return this.setGlobalLock(true)
  }

  async unfreezeAll(): Promise<TxOutcome> {
    return this.setGlobalLock(false)
  }

  private async setHolderLock(holder: string, lock: boolean): Promise<TxOutcome> {
    const state = await this.getHolderState(holder)
    if (!state.optedIn) throw new IssuerError('HOLDER_NOT_OPTED_IN', `${holder} has no position in issuance ${this.issuanceId} to ${lock ? 'freeze' : 'unfreeze'}`)
    if (state.frozen === lock) return { txHash: null }
    const result = await this.submitter.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.logger.info(lock ? 'holder.frozen' : 'holder.unfrozen', { issuanceId: this.issuanceId, holder, txHash: result.hash })
    return { txHash: result.hash }
  }

  private async setGlobalLock(lock: boolean): Promise<TxOutcome> {
    const { globallyFrozen } = await this.getIssuanceState()
    if (globallyFrozen === lock) return { txHash: null }
    const result = await this.submitter.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.logger.info(lock ? 'issuance.frozen' : 'issuance.unfrozen', { issuanceId: this.issuanceId, txHash: result.hash })
    return { txHash: result.hash }
  }

  // ------------------------------------------------------------------ bans

  /**
   * Bans an address permanently. In order:
   *  1. records the ban durably, so it is never re-approved or paid again;
   *  2. removes it from the allowlist, so nobody can send it the token;
   *  3. claws back its entire balance;
   *  4. freezes its position as defence in depth;
   * then re-reads the ledger and throws BAN_INCOMPLETE unless the address
   * holds nothing and cannot receive. Safe to retry after any failure.
   */
  async banHolder(holder: string, reason: string): Promise<BanOutcome> {
    this.assertHolderAddress(holder)
    const existing = await this.bans.get(holder)
    const ban = existing ?? { address: holder, reason, bannedAt: new Date().toISOString() }
    if (existing === undefined) {
      await this.bans.add(ban)
      this.logger.info('holder.ban_recorded', { issuanceId: this.issuanceId, holder, reason })
    }

    const txHashes: string[] = []
    let clawed = 0n
    const record = (outcome: TxOutcome): void => {
      if (outcome.txHash !== null) txHashes.push(outcome.txHash)
    }
    try {
      const before = await this.getHolderState(holder)
      if (before.optedIn) {
        record(await this.deauthorizeHolder(holder))
        const clawback = await this.clawbackAll(holder)
        if (clawback !== null) {
          txHashes.push(clawback.txHash)
          clawed = toUnitsOrZero(clawback.amount, this.assetScale)
        }
        record(await this.setHolderLock(holder, true))
      }
    } catch (error) {
      throw new IssuerError('BAN_INCOMPLETE', `Ban of ${holder} is recorded but on-ledger enforcement failed; retry banHolder`, { cause: error })
    }

    const after = await this.getHolderState(holder)
    const failures = [
      ...(after.authorized ? ['still authorized'] : []),
      ...(after.balance !== '0' ? [`still holds ${after.balance}`] : []),
      ...(after.lockedAmount !== '0' ? [`still has ${after.lockedAmount} in escrow`] : []),
    ]
    if (failures.length > 0) {
      throw new IssuerError('BAN_INCOMPLETE', `Ban of ${holder} is recorded but ${failures.join(', ')}; retry banHolder`)
    }
    this.logger.info('holder.banned', { issuanceId: this.issuanceId, holder, clawedBack: this.format(clawed), txHashes })
    return { ban, txHashes, clawedBack: this.format(clawed) }
  }

  // --------------------------------------------------------------- helpers

  private format(units: bigint): string {
    return fromBaseUnits(units, this.assetScale)
  }

  private assertHolderAddress(holder: string): void {
    if (!isValidClassicAddress(holder)) {
      throw new IssuerError('INVALID_ADDRESS', `"${holder}" is not a valid classic XRPL address`)
    }
    if (holder === this.issuerAddress) {
      throw new IssuerError('INVALID_ADDRESS', 'The issuer cannot be a holder of its own token')
    }
  }

  private async assertNotBanned(holder: string): Promise<void> {
    this.assertHolderAddress(holder)
    const ban = await this.bans.get(holder)
    if (ban !== undefined) {
      throw new IssuerError('HOLDER_BANNED', `${holder} was banned at ${ban.bannedAt}: ${ban.reason}`)
    }
  }

  private async holderBalance(holder: string): Promise<bigint> {
    return BigInt((await this.fetchHolderToken(holder))?.MPTAmount ?? '0')
  }

  private async fetchHolderToken(holder: string): Promise<MPTokenEntry | undefined> {
    return fetchEntry<MPTokenEntry>(this.client, { mptoken: { mpt_issuance_id: this.issuanceId, account: holder } })
  }

  /**
   * Net change of `holder`'s balance of this issuance in the metadata of a
   * Payment or Clawback. Those only touch a holder's MPToken to change its
   * balance, and zero balances are omitted from ledger entries, so an absent
   * MPTAmount on either side means 0.
   */
  private balanceChange(meta: TransactionMetadata, holder: string): bigint {
    for (const node of meta.AffectedNodes) {
      if (!('ModifiedNode' in node) || node.ModifiedNode.LedgerEntryType !== 'MPToken') continue
      const final = node.ModifiedNode.FinalFields as Partial<MPTokenEntry> | undefined
      const previous = node.ModifiedNode.PreviousFields as Partial<MPTokenEntry> | undefined
      if (final?.Account !== holder || final.MPTokenIssuanceID !== this.issuanceId) continue
      return BigInt(final.MPTAmount ?? '0') - BigInt(previous?.MPTAmount ?? '0')
    }
    return 0n
  }
}

interface MPTokenIssuanceEntry {
  Issuer: string
  Flags: number
  AssetScale?: number
  OutstandingAmount?: string
  MaximumAmount?: string
  DomainID?: string
}

interface MPTokenEntry {
  Account: string
  MPTokenIssuanceID: string
  Flags: number
  MPTAmount?: string
  LockedAmount?: string
}

async function fetchIssuance(client: Client, issuanceId: string): Promise<MPTokenIssuanceEntry> {
  const issuance = await fetchEntry<MPTokenIssuanceEntry>(client, { mpt_issuance: issuanceId })
  if (issuance === undefined) {
    throw new IssuerError('ISSUANCE_NOT_FOUND', `MPT issuance ${issuanceId} does not exist in the validated ledger`)
  }
  return issuance
}

/** Reads a ledger entry from the latest validated ledger; undefined if it does not exist. */
async function fetchEntry<T>(client: Client, selector: Record<string, unknown>): Promise<T | undefined> {
  try {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector })
    return response.result.node as T | undefined
  } catch (error) {
    if (error instanceof XrplError && (error.data as { error?: string } | undefined)?.error === 'entryNotFound') return undefined
    throw error
  }
}

function toUnitsOrZero(amount: string, assetScale: number): bigint {
  return amount === '0' ? 0n : toBaseUnits(amount, assetScale)
}
