import {
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceCreateImmutableFlags,
  MPTokenIssuanceSetFlags,
  RippledError,
  decodeAccountID,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  validateMPTokenMetadata,
  type Client,
  type MPTokenIssuanceCreate,
  type MPTokenMetadata,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl'

import { MAX_MPT_AMOUNT, parsePositiveAmount, type MptAmount } from './amounts.js'
import type { BanRegistry } from './banRegistry.js'
import { ComplianceError, InvalidArgumentError, IssuanceConfigError } from './errors.js'
import { Submitter, type SubmitterOptions, type ValidatedTransaction } from './submitter.js'

/**
 * `MPTokenIssuance` ledger entry flags (not exported by xrpl.js).
 * https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance
 */
export const MPTokenIssuanceFlags = {
  lsfMPTLocked: 0x00000001,
  lsfMPTCanLock: 0x00000002,
  lsfMPTRequireAuth: 0x00000004,
  lsfMPTCanEscrow: 0x00000008,
  lsfMPTCanTrade: 0x00000010,
  lsfMPTCanTransfer: 0x00000020,
  lsfMPTCanClawback: 0x00000040,
  lsfMPTCanHoldConfidentialBalance: 0x00000080,
} as const

/** `MPToken` ledger entry flags (not exported by xrpl.js). */
export const MPTokenLedgerFlags = {
  lsfMPTLocked: 0x00000001,
  lsfMPTAuthorized: 0x00000002,
} as const

/** Capabilities every issuance managed by this module must have. */
export const REQUIRED_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTRequireAuth |
  MPTokenIssuanceFlags.lsfMPTCanLock |
  MPTokenIssuanceFlags.lsfMPTCanClawback

/**
 * Capabilities that let holders move balances somewhere Clawback, locks or
 * the allowlist cannot reach. Escrowed amounts sit in `LockedAmount`, which
 * Clawback ignores. DEX/AMM holdings belong to AMM pseudo-accounts.
 * Confidential balances are encrypted. The module refuses to manage an
 * issuance that has any of them.
 */
export const FORBIDDEN_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanEscrow |
  MPTokenIssuanceFlags.lsfMPTCanTrade |
  MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance

/**
 * Immutable flags used when the DynamicMPT amendment is active (it makes
 * issuance flags mutable by default). Locking every capability keeps the
 * compliance configuration exactly as created: the required controls can't be
 * disabled, and escrow, trading and confidential balances can never be turned
 * on. Metadata and transfer fee stay mutable.
 */
export const DYNAMIC_MPT_IMMUTABLE_FLAGS =
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanLock |
  MPTokenIssuanceCreateImmutableFlags.tifMPTRequireAuth |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanEscrow |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanTrade |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanTransfer |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanClawback |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanHoldConfidentialBalance

export interface CreateIssuanceOptions {
  /** XLS-89 metadata. Validated strictly; encoded size must be ≤ 1024 bytes. */
  metadata: MPTokenMetadata
  /** Decimal places for display (0–255 on-ledger; 0–19 is meaningful). Default 0. */
  assetScale?: number
  /** Supply cap in smallest units. Omit for the ledger maximum (2^63 − 1). */
  maximumAmount?: MptAmount
  /** Allow approved holders to transfer among themselves. Default true. */
  canTransfer?: boolean
  /** Transfer fee in units of 0.001% (0–50000). Requires canTransfer. Default 0. */
  transferFee?: number
  /**
   * Whether to set ImmutableFlags ({@link DYNAMIC_MPT_IMMUTABLE_FLAGS}).
   * 'auto' (default) sets them only when the DynamicMPT amendment is enabled
   * (the field is rejected with temDISABLED otherwise, and without DynamicMPT
   * issuance flags are immutable anyway).
   */
  lockConfiguration?: 'auto' | boolean
}

export interface MptIssuerOptions {
  /** Durable ban list. See {@link BanRegistry}. */
  banRegistry: BanRegistry
  submitter?: SubmitterOptions
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  flags: number
  globallyFrozen: boolean
  outstandingAmount: bigint
  maximumAmount: bigint
  assetScale: number
  transferFee: number
  immutableFlags: number
  domainId: string | undefined
}

export interface HolderState {
  address: string
  /** Whether the holder has opted in (an MPToken entry exists). */
  hasMPToken: boolean
  /** On the issuer's allowlist (lsfMPTAuthorized). */
  approved: boolean
  /** Individually locked (lsfMPTLocked). */
  frozen: boolean
  balance: bigint
  /** Amount held in escrow; always 0 for issuances this module accepts. */
  lockedAmount: bigint
  /** In the issuer's ban registry. */
  banned: boolean
}

export interface SubmittedTransaction {
  type: string
  hash: string
  ledgerIndex: number
}

/**
 * Audit record for a compliance action. `transactions` is empty when the
 * ledger was already in the requested state and nothing had to be submitted.
 */
export interface ActionReceipt {
  action: string
  issuanceId: string
  holder?: string
  transactions: SubmittedTransaction[]
}

export interface ClawbackReceipt extends ActionReceipt {
  /** Amount actually removed from the holder, from the validated metadata. */
  amountClawedBack: bigint
}

export interface BanReceipt extends ActionReceipt {
  amountClawedBack: bigint
}

/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * Controls map onto the ledger like this:
 * - Allowlist: `lsfMPTRequireAuth` + MPTokenAuthorize from the issuer.
 * - Clawback: `lsfMPTCanClawback` + Clawback. Ignores locks and authorisation.
 * - Per-holder freeze: MPTokenIssuanceSet `tfMPTLock` with `Holder`.
 * - Global freeze: MPTokenIssuanceSet `tfMPTLock` without `Holder`.
 * - Ban: ban registry + unauthorize + lock + claw back the full balance.
 *
 * On-ledger locks only block holder-to-holder transfers. The ledger still
 * lets the issuer pay a locked holder, so every issuance path here checks
 * freeze state first. A locked (but still approved) holder can also pay the
 * issuer directly: the protocol allows redemption/burn during a freeze, as
 * with trust-line deep freeze. Bans remove approval, which blocks that too.
 *
 * All issuer transactions go through one serialised {@link Submitter};
 * precondition checks and the resulting submission run in the same critical
 * section. Run a single instance per issuer key.
 */
export class MptIssuer {
  readonly issuanceId: string
  readonly issuerAddress: string
  private readonly client: Client
  private readonly submitter: Submitter
  private readonly bans: BanRegistry

  private constructor(client: Client, submitter: Submitter, issuanceId: string, bans: BanRegistry) {
    this.client = client
    this.submitter = submitter
    this.issuerAddress = submitter.address
    this.issuanceId = issuanceId
    this.bans = bans
  }

  /** Creates a new issuance with every compliance control enabled. */
  static async createIssuance(
    client: Client,
    issuerWallet: Wallet,
    create: CreateIssuanceOptions,
    options: MptIssuerOptions,
  ): Promise<{ issuer: MptIssuer; transaction: SubmittedTransaction }> {
    const tx = await buildIssuanceCreate(client, issuerWallet.classicAddress, create)
    const submitter = new Submitter(client, issuerWallet, options.submitter)
    const result = await submitter.submit(tx)
    const issuanceId = (result.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    if (issuanceId === undefined) {
      throw new IssuanceConfigError(`MPTokenIssuanceCreate ${result.hash} metadata has no mpt_issuance_id`)
    }
    const issuer = new MptIssuer(client, submitter, issuanceId, options.banRegistry)
    await issuer.getIssuance() // verifies the configuration landed as intended
    return { issuer, transaction: toSubmitted('MPTokenIssuanceCreate', result) }
  }

  /** Attaches to an existing issuance, verifying it is safe to manage. */
  static async attach(
    client: Client,
    issuerWallet: Wallet,
    issuanceId: string,
    options: MptIssuerOptions,
  ): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
      throw new InvalidArgumentError(`Invalid MPT issuance ID: ${issuanceId}`)
    }
    const submitter = new Submitter(client, issuerWallet, options.submitter)
    const issuer = new MptIssuer(client, submitter, issuanceId.toUpperCase(), options.banRegistry)
    await issuer.getIssuance()
    return issuer
  }

  // ---------------------------------------------------------------- reads

  /**
   * Reads the issuance from the latest validated ledger and verifies that it
   * belongs to this issuer and still has a safe configuration.
   */
  async getIssuance(): Promise<IssuanceState> {
    const node = await this.ledgerEntry({ mpt_issuance: this.issuanceId })
    if (node === undefined || node['LedgerEntryType'] !== 'MPTokenIssuance') {
      throw new IssuanceConfigError(`MPT issuance ${this.issuanceId} not found in the validated ledger`)
    }
    const state: IssuanceState = {
      issuanceId: this.issuanceId,
      issuer: String(node['Issuer']),
      flags: Number(node['Flags'] ?? 0),
      globallyFrozen: (Number(node['Flags'] ?? 0) & MPTokenIssuanceFlags.lsfMPTLocked) !== 0,
      outstandingAmount: BigInt(String(node['OutstandingAmount'] ?? '0')),
      maximumAmount: node['MaximumAmount'] === undefined ? MAX_MPT_AMOUNT : BigInt(String(node['MaximumAmount'])),
      assetScale: Number(node['AssetScale'] ?? 0),
      transferFee: Number(node['TransferFee'] ?? 0),
      immutableFlags: Number(node['ImmutableFlags'] ?? 0),
      domainId: node['DomainID'] === undefined ? undefined : String(node['DomainID']),
    }
    assertSafeIssuance(state, this.issuerAddress)
    return state
  }

  /** Reads a holder's state from the latest validated ledger. */
  async getHolder(address: string): Promise<HolderState> {
    this.assertHolderAddress(address)
    const [node, banned] = await Promise.all([
      this.ledgerEntry({ mptoken: { mpt_issuance_id: this.issuanceId, account: address } }),
      this.bans.isBanned(address),
    ])
    if (node === undefined) {
      return { address, hasMPToken: false, approved: false, frozen: false, balance: 0n, lockedAmount: 0n, banned }
    }
    const flags = Number(node['Flags'] ?? 0)
    return {
      address,
      hasMPToken: true,
      approved: (flags & MPTokenLedgerFlags.lsfMPTAuthorized) !== 0,
      frozen: (flags & MPTokenLedgerFlags.lsfMPTLocked) !== 0,
      // MPTAmount / LockedAmount are omitted from the entry when zero.
      balance: BigInt(String(node['MPTAmount'] ?? '0')),
      lockedAmount: BigInt(String(node['LockedAmount'] ?? '0')),
      banned,
    }
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Adds a KYC-approved holder to the allowlist. The holder must already have
   * opted in (submitted their own MPTokenAuthorize). Banned addresses are
   * refused.
   */
  async approveHolder(address: string): Promise<ActionReceipt> {
    this.assertHolderAddress(address)
    return this.submitter.exclusive(async () => {
      await this.getIssuance()
      const holder = await this.getHolder(address)
      if (holder.banned) {
        throw new ComplianceError(`${address} is banned and cannot be approved`)
      }
      if (!holder.hasMPToken) {
        throw new ComplianceError(`${address} has not opted in to ${this.issuanceId} (no MPToken entry)`)
      }
      if (holder.approved) {
        return this.receipt('approveHolder', address, [])
      }
      const result = await this.submitter.submitUnlocked({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
      return this.receipt('approveHolder', address, [toSubmitted('MPTokenAuthorize', result)])
    })
  }

  /**
   * Removes a holder from the allowlist (for example, when KYC lapses). The
   * holder keeps their balance but can no longer send or receive the token.
   */
  async revokeApproval(address: string): Promise<ActionReceipt> {
    this.assertHolderAddress(address)
    return this.submitter.exclusive(async () => {
      await this.getIssuance()
      const holder = await this.getHolder(address)
      if (!holder.hasMPToken || !holder.approved) {
        return this.receipt('revokeApproval', address, [])
      }
      const result = await this.unauthorizeUnlocked(address)
      return this.receipt('revokeApproval', address, [result])
    })
  }

  // ------------------------------------------------------------- issuance

  /**
   * Pays newly issued tokens to an approved holder. Refused while the token
   * is globally frozen, or if the holder is banned, unapproved or frozen.
   */
  async issue(address: string, amount: MptAmount): Promise<ActionReceipt> {
    this.assertHolderAddress(address)
    const value = parsePositiveAmount(amount)
    return this.submitter.exclusive(async () => {
      const issuance = await this.getIssuance()
      if (issuance.globallyFrozen) {
        throw new ComplianceError(`${this.issuanceId} is globally frozen; issuance is suspended`)
      }
      const holder = await this.getHolder(address)
      if (holder.banned) {
        throw new ComplianceError(`${address} is banned`)
      }
      if (!holder.hasMPToken || !holder.approved) {
        throw new ComplianceError(`${address} is not an approved holder of ${this.issuanceId}`)
      }
      if (holder.frozen) {
        throw new ComplianceError(`${address} is frozen`)
      }
      if (issuance.outstandingAmount + value > issuance.maximumAmount) {
        throw new ComplianceError(
          `Issuing ${value} would exceed the maximum supply (${issuance.outstandingAmount} of ${issuance.maximumAmount} outstanding)`,
        )
      }
      const result = await this.submitter.submitUnlocked({
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: value.toString() },
      })
      const delivered = outstandingAmountChange(result.meta, this.issuanceId)
      if (delivered !== value) {
        // Should be impossible without tfPartialPayment; surface loudly if it happens.
        throw new ComplianceError(
          `Payment ${result.hash} validated but delivered ${delivered} instead of ${value}`,
        )
      }
      return this.receipt('issue', address, [toSubmitted('Payment', result)])
    })
  }

  // ------------------------------------------------------------- clawback

  /**
   * Claws back `amount` (or the whole balance with 'all') from a holder,
   * regardless of freeze or approval status. An explicit amount larger than
   * the balance is rejected rather than silently reduced (which is what the
   * ledger would do).
   */
  async clawback(address: string, amount: MptAmount | 'all'): Promise<ClawbackReceipt> {
    this.assertHolderAddress(address)
    const requested = amount === 'all' ? 'all' : parsePositiveAmount(amount)
    return this.submitter.exclusive(async () => {
      await this.getIssuance()
      const holder = await this.getHolder(address)
      if (requested === 'all' && holder.balance === 0n) {
        return { ...this.receipt('clawback', address, []), amountClawedBack: 0n }
      }
      if (requested !== 'all' && requested > holder.balance) {
        throw new InvalidArgumentError(`Cannot claw back ${requested} from ${address}: balance is ${holder.balance}`)
      }
      const value = requested === 'all' ? holder.balance : requested
      const { transaction, amount: clawed } = await this.clawbackUnlocked(address, value)
      return { ...this.receipt('clawback', address, [transaction]), amountClawedBack: clawed }
    })
  }

  // ----------------------------------------------------------------- bans

  /**
   * Bans an address: records it in the ban registry, removes it from the
   * allowlist, locks its MPToken and claws back its entire balance. On
   * success the address holds none of the token and cannot receive it again.
   * The issuer won't approve or pay it, and the ledger rejects payments to it
   * from anyone.
   *
   * Idempotent: re-running completes a ban that was interrupted part-way.
   */
  async ban(address: string, reason?: string): Promise<BanReceipt> {
    this.assertHolderAddress(address)
    // Persist first: from here on no other code path will approve or pay
    // this address, even if the ledger steps below fail and are retried.
    await this.bans.add({
      address,
      bannedAt: new Date().toISOString(),
      ...(reason === undefined ? {} : { reason }),
    })
    return this.submitter.exclusive(async () => {
      await this.getIssuance()
      const transactions: SubmittedTransaction[] = []
      let clawed = 0n
      let holder = await this.getHolder(address)
      if (holder.hasMPToken) {
        // 1. Unauthorize first. This blocks every payment to or from the
        //    holder, including redemption to the issuer, so the balance can't
        //    change under us.
        if (holder.approved) {
          transactions.push(await this.unauthorizeUnlocked(address))
        }
        // 2. Lock. Defence in depth: keeps the holder frozen even if they are
        //    ever re-approved by mistake. With fixCleanup3_4_0 it also stops
        //    them deleting the MPToken.
        if (!holder.frozen) {
          transactions.push(await this.setLockUnlocked(address, true))
        }
        // 3. Claw back everything.
        holder = await this.getHolder(address)
        if (holder.balance > 0n) {
          const { transaction, amount } = await this.clawbackUnlocked(address, holder.balance)
          transactions.push(transaction)
          clawed = amount
        }
        holder = await this.getHolder(address)
        if (holder.approved || !holder.frozen || holder.balance !== 0n || holder.lockedAmount !== 0n) {
          throw new ComplianceError(
            `Ban of ${address} incomplete: approved=${holder.approved} frozen=${holder.frozen} ` +
              `balance=${holder.balance} lockedAmount=${holder.lockedAmount}`,
          )
        }
      }
      return { ...this.receipt('ban', address, transactions), amountClawedBack: clawed }
    })
  }

  async isBanned(address: string): Promise<boolean> {
    return this.bans.isBanned(address)
  }

  // --------------------------------------------------------------- freezes

  /** Freezes one holder: they can no longer send or receive the token. */
  async freezeHolder(address: string): Promise<ActionReceipt> {
    return this.setHolderLock(address, true)
  }

  /** Lifts a per-holder freeze. Refused for banned addresses. */
  async unfreezeHolder(address: string): Promise<ActionReceipt> {
    return this.setHolderLock(address, false)
  }

  /** Freezes all transfers of the token and suspends issuance. */
  async freezeAll(): Promise<ActionReceipt> {
    return this.setGlobalLock(true)
  }

  /** Lifts the global freeze. Per-holder freezes stay in place. */
  async unfreezeAll(): Promise<ActionReceipt> {
    return this.setGlobalLock(false)
  }

  // --------------------------------------------------------------- helpers

  private async setHolderLock(address: string, lock: boolean): Promise<ActionReceipt> {
    this.assertHolderAddress(address)
    const action = lock ? 'freezeHolder' : 'unfreezeHolder'
    return this.submitter.exclusive(async () => {
      await this.getIssuance()
      const holder = await this.getHolder(address)
      if (!lock && holder.banned) {
        throw new ComplianceError(`${address} is banned and cannot be unfrozen`)
      }
      if (!holder.hasMPToken) {
        throw new ComplianceError(`${address} has no MPToken for ${this.issuanceId}; nothing to ${lock ? 'freeze' : 'unfreeze'}`)
      }
      if (holder.frozen === lock) {
        return this.receipt(action, address, [])
      }
      return this.receipt(action, address, [await this.setLockUnlocked(address, lock)])
    })
  }

  private async setGlobalLock(lock: boolean): Promise<ActionReceipt> {
    const action = lock ? 'freezeAll' : 'unfreezeAll'
    return this.submitter.exclusive(async () => {
      const issuance = await this.getIssuance()
      if (issuance.globallyFrozen === lock) {
        return this.receipt(action, undefined, [])
      }
      return this.receipt(action, undefined, [await this.setLockUnlocked(undefined, lock)])
    })
  }

  private async setLockUnlocked(holder: string | undefined, lock: boolean): Promise<SubmittedTransaction> {
    const result = await this.submitter.submitUnlocked({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      ...(holder === undefined ? {} : { Holder: holder }),
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    return toSubmitted('MPTokenIssuanceSet', result)
  }

  private async unauthorizeUnlocked(address: string): Promise<SubmittedTransaction> {
    const result = await this.submitter.submitUnlocked({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    return toSubmitted('MPTokenAuthorize', result)
  }

  private async clawbackUnlocked(
    address: string,
    value: bigint,
  ): Promise<{ transaction: SubmittedTransaction; amount: bigint }> {
    const result = await this.submitter.submitUnlocked({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value: value.toString() },
      Holder: address,
    })
    const amount = -outstandingAmountChange(result.meta, this.issuanceId)
    return { transaction: toSubmitted('Clawback', result), amount }
  }

  private async ledgerEntry(
    selector: { mpt_issuance: string } | { mptoken: { mpt_issuance_id: string; account: string } },
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        ledger_index: 'validated',
        ...selector,
      })
      return response.result.node as unknown as Record<string, unknown> | undefined
    } catch (error) {
      if (
        error instanceof RippledError &&
        typeof error.data === 'object' &&
        error.data !== null &&
        (error.data as Record<string, unknown>)['error'] === 'entryNotFound'
      ) {
        return undefined
      }
      throw error
    }
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) {
      throw new InvalidArgumentError(`Invalid classic address: ${address}`)
    }
    if (address === this.issuerAddress) {
      throw new InvalidArgumentError('The issuer cannot be a holder of its own token')
    }
  }

  private receipt(action: string, holder: string | undefined, transactions: SubmittedTransaction[]): ActionReceipt {
    return {
      action,
      issuanceId: this.issuanceId,
      ...(holder === undefined ? {} : { holder }),
      transactions,
    }
  }
}

// ------------------------------------------------------------ pure helpers

/** Builds (but does not submit) the MPTokenIssuanceCreate transaction. */
export async function buildIssuanceCreate(
  client: Client,
  issuerAddress: string,
  options: CreateIssuanceOptions,
): Promise<MPTokenIssuanceCreate> {
  const lock =
    options.lockConfiguration === undefined || options.lockConfiguration === 'auto'
      ? await isAmendmentEnabled(client, 'DynamicMPT')
      : options.lockConfiguration
  return issuanceCreateTransaction(issuerAddress, options, lock)
}

/** Pure part of {@link buildIssuanceCreate}; exported for testing. */
export function issuanceCreateTransaction(
  issuerAddress: string,
  options: CreateIssuanceOptions,
  lockConfiguration: boolean,
): MPTokenIssuanceCreate {
  const assetScale = options.assetScale ?? 0
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 19) {
    throw new InvalidArgumentError(`assetScale must be an integer from 0 to 19, got ${assetScale}`)
  }
  const canTransfer = options.canTransfer ?? true
  const transferFee = options.transferFee ?? 0
  if (!Number.isInteger(transferFee) || transferFee < 0 || transferFee > 50_000) {
    throw new InvalidArgumentError(`transferFee must be an integer from 0 to 50000, got ${transferFee}`)
  }
  if (transferFee > 0 && !canTransfer) {
    throw new InvalidArgumentError('transferFee requires canTransfer')
  }

  const metadataHex = encodeMPTokenMetadata(options.metadata)
  const problems = validateMPTokenMetadata(metadataHex)
  if (problems.length > 0) {
    throw new InvalidArgumentError(`MPTokenMetadata does not follow XLS-89: ${problems.join('; ')}`)
  }
  if (metadataHex.length / 2 > 1024) {
    throw new InvalidArgumentError(`MPTokenMetadata is ${metadataHex.length / 2} bytes; the limit is 1024`)
  }

  let flags =
    MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
    MPTokenIssuanceCreateFlags.tfMPTCanLock |
    MPTokenIssuanceCreateFlags.tfMPTCanClawback
  if (canTransfer) {
    flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer
  }

  return {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: issuerAddress,
    Flags: flags,
    AssetScale: assetScale,
    MPTokenMetadata: metadataHex,
    ...(options.maximumAmount === undefined
      ? {}
      : { MaximumAmount: parsePositiveAmount(options.maximumAmount, 'maximumAmount').toString() }),
    ...(transferFee > 0 ? { TransferFee: transferFee } : {}),
    ...(lockConfiguration ? { ImmutableFlags: DYNAMIC_MPT_IMMUTABLE_FLAGS } : {}),
  }
}

/** Throws {@link IssuanceConfigError} unless the issuance is safe to manage. */
export function assertSafeIssuance(state: IssuanceState, expectedIssuer: string): void {
  if (state.issuer !== expectedIssuer) {
    throw new IssuanceConfigError(`${state.issuanceId} is issued by ${state.issuer}, not ${expectedIssuer}`)
  }
  const missing = REQUIRED_ISSUANCE_FLAGS & ~state.flags
  if (missing !== 0) {
    throw new IssuanceConfigError(
      `${state.issuanceId} lacks required capabilities (missing flag bits 0x${missing.toString(16)}: ` +
        'Require Auth, Can Lock and Can Clawback are all required)',
    )
  }
  const forbidden = FORBIDDEN_ISSUANCE_FLAGS & state.flags
  if (forbidden !== 0) {
    throw new IssuanceConfigError(
      `${state.issuanceId} enables escrow, trading or confidential balances (flag bits 0x${forbidden.toString(16)}), ` +
        'which let holders move tokens beyond clawback and freeze controls',
    )
  }
  if (state.domainId !== undefined) {
    throw new IssuanceConfigError(
      `${state.issuanceId} has a permissioned domain (${state.domainId}); domain credentials would bypass the allowlist and bans`,
    )
  }
}

/**
 * Net change in the issuance's OutstandingAmount recorded in a transaction's
 * metadata. For issuer-to-holder payments this equals the amount delivered;
 * for Clawback it is minus the amount clawed back. OutstandingAmount is a
 * required field, so its previous value is always in PreviousFields when it
 * changes. MPToken.MPTAmount is omitted at zero, so a 0 -> N change would not
 * show up in PreviousFields.
 */
export function outstandingAmountChange(meta: TransactionMetadata, issuanceId: string): bigint {
  for (const affected of meta.AffectedNodes) {
    if (!('ModifiedNode' in affected)) {
      continue
    }
    const node = affected.ModifiedNode
    if (node.LedgerEntryType !== 'MPTokenIssuance' || node.FinalFields === undefined) {
      continue
    }
    const id = mptIssuanceId(Number(node.FinalFields['Sequence']), String(node.FinalFields['Issuer']))
    if (id !== issuanceId.toUpperCase()) {
      continue
    }
    const after = BigInt(String(node.FinalFields['OutstandingAmount']))
    const previous = node.PreviousFields?.['OutstandingAmount']
    return previous === undefined ? 0n : after - BigInt(String(previous))
  }
  return 0n
}

/** MPTokenIssuanceID = 32-bit big-endian sequence || 160-bit issuer AccountID. */
export function mptIssuanceId(sequence: number, issuer: string): string {
  const accountId = Buffer.from(decodeAccountID(issuer)).toString('hex')
  return (sequence.toString(16).padStart(8, '0') + accountId).toUpperCase()
}

/** Queries the public `feature` method. Throws if the server won't say. */
export async function isAmendmentEnabled(client: Client, name: string): Promise<boolean> {
  const response = await client.request({ command: 'feature', feature: name })
  const entries = Object.values(response.result as unknown as Record<string, { name?: string; enabled?: boolean }>)
  const entry = entries.find((candidate) => candidate.name === name)
  if (entry === undefined) {
    throw new Error(`Server did not report amendment ${name}`)
  }
  return entry.enabled === true
}

function toSubmitted(type: string, result: ValidatedTransaction): SubmittedTransaction {
  return { type, hash: result.hash, ledgerIndex: result.ledgerIndex }
}
