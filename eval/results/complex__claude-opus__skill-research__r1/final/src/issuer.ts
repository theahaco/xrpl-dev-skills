import {
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  RippledError,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  type Client,
  LedgerEntry,
  type MPTAmount,
  type MPTokenMetadata,
  type Node,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl'

import { type BaseUnits, parseBaseUnits } from './amounts.js'
import type { BanRegistry } from './banRegistry.js'
import {
  BannedHolderError,
  ComplianceConfigError,
  FrozenError,
  HolderNotApprovedError,
  HolderNotOptedInError,
  LedgerStateMismatchError,
  MptIssuerError,
  TransactionFailedError,
} from './errors.js'

const { MPTokenIssuanceFlags } = LedgerEntry

/** MPToken ledger-entry flags (xrpl.js exports no enum for these). */
const lsfMPTLocked = 0x00000001
const lsfMPTAuthorized = 0x00000002

/** Issuance capabilities every compliance control depends on. */
const REQUIRED_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanLock | MPTokenIssuanceFlags.lsfMPTRequireAuth | MPTokenIssuanceFlags.lsfMPTCanClawback

/**
 * Capabilities that would let value leave the holder's clawback-able balance:
 * escrowed tokens are tracked as LockedAmount, which Clawback cannot touch;
 * DEX/AMM trading moves balances into offers and pools; confidential balances
 * are encrypted. Any of these would break the "banned address ends up holding
 * none" guarantee, so the module refuses to manage an issuance that has them.
 */
const FORBIDDEN_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanEscrow |
  MPTokenIssuanceFlags.lsfMPTCanTrade |
  MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance

export interface CreateIssuanceOptions {
  /** XLS-89 metadata; encoded on-chain (max 1024 bytes). */
  metadata: MPTokenMetadata
  /** Decimal places between base units and display units. Immutable. Default 0. */
  assetScale?: number
  /** Supply cap in base units. Omit for the protocol maximum (2^63 - 1). */
  maximumAmount?: BaseUnits
  /** Allow approved holders to pay each other (not just the issuer). Default true. */
  transferable?: boolean
  /** Transfer fee in units of 0.001% (0..50000). Requires transferable. */
  transferFee?: number
}

export interface IssuerOptions {
  banRegistry: BanRegistry
}

export interface IssuanceStatus {
  issuanceId: string
  issuer: string
  assetScale: number
  outstandingAmount: bigint
  maximumAmount: bigint | undefined
  globallyFrozen: boolean
  canLock: boolean
  requireAuth: boolean
  canClawback: boolean
  canTransfer: boolean
  canEscrow: boolean
  canTrade: boolean
  domainId: string | undefined
  flags: number
}

export interface HolderStatus {
  address: string
  /** The holder has an MPToken entry (has opted in to holding the token). */
  optedIn: boolean
  /** The issuer has authorized (allow-listed) the holder. */
  approved: boolean
  /** The holder's balance is individually locked. Does not reflect a global freeze. */
  frozen: boolean
  balance: bigint
  /** Amount held in escrow (TokenEscrow); always 0 for issuances this module manages. */
  escrowed: bigint
}

export interface TxReceipt {
  hash: string
  ledgerIndex: number | undefined
}

export interface ClawbackReceipt extends TxReceipt {
  requested: bigint
  /** Actual amount removed; the ledger caps a clawback at the holder's balance. */
  clawedBack: bigint
}

export interface BanReport {
  address: string
  /** Transactions submitted to enforce the ban, in order. */
  steps: Array<{ action: 'unauthorize' | 'freeze' | 'clawback'; hash: string }>
  clawedBack: bigint
  finalStatus: HolderStatus
}

function assertAddress(address: string, label = 'address'): void {
  if (!isValidClassicAddress(address)) {
    throw new MptIssuerError(`Invalid ${label}: ${JSON.stringify(address)} is not a classic XRPL address`)
  }
}

function isEntryNotFound(error: unknown): boolean {
  return (
    error instanceof RippledError &&
    typeof error.data === 'object' &&
    error.data !== null &&
    (error.data as { error?: unknown }).error === 'entryNotFound'
  )
}

/**
 * Sign, submit and wait for validation. Resolves only for tesSUCCESS in a
 * validated ledger; every other outcome throws TransactionFailedError.
 */
export async function submitTransaction(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<TxReceipt & { meta: TransactionMetadata }> {
  let response
  try {
    // failHard: a transaction that fails locally is not relayed or retried.
    response = await client.submitAndWait(tx, { wallet, autofill: true, failHard: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = /\b(te[cfmlr][A-Z_]+|ter[A-Z_]+)\b/.exec(message)?.[1] ?? 'submitError'
    throw new TransactionFailedError(tx.TransactionType, code, undefined, { cause: error })
  }
  const { meta, hash, validated, ledger_index: ledgerIndex } = response.result
  if (typeof meta !== 'object' || meta === null) {
    throw new TransactionFailedError(tx.TransactionType, 'missingMetadata', hash)
  }
  if (!validated) {
    throw new TransactionFailedError(tx.TransactionType, 'notValidated', hash)
  }
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new TransactionFailedError(tx.TransactionType, meta.TransactionResult, hash)
  }
  return { hash, ledgerIndex, meta }
}

/**
 * Holder-side opt-in: creates the holder's MPToken entry so the issuer can
 * approve it. Signed by the holder, not the issuer.
 */
export async function optInAsHolder(client: Client, holder: Wallet, issuanceId: string): Promise<TxReceipt> {
  const { hash, ledgerIndex } = await submitTransaction(client, holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  })
  return { hash, ledgerIndex }
}

function findModifiedNode(meta: TransactionMetadata, entryType: string, predicate: (fields: Record<string, unknown>) => boolean) {
  for (const node of meta.AffectedNodes as Node[]) {
    if ('ModifiedNode' in node && node.ModifiedNode.LedgerEntryType === entryType) {
      const fields = node.ModifiedNode.FinalFields ?? {}
      if (predicate(fields)) return node.ModifiedNode
    }
  }
  return undefined
}

/**
 * Issuer-side compliance controls for a single MPT issuance.
 *
 * Use one instance per issuing account: submissions are serialized so that
 * concurrent calls from the backend don't race for account sequence numbers.
 * All reads use the latest validated ledger.
 */
export class MptIssuer {
  readonly client: Client
  readonly wallet: Wallet
  readonly issuanceId: string
  readonly #banRegistry: BanRegistry
  #queue: Promise<unknown> = Promise.resolve()

  private constructor(client: Client, wallet: Wallet, issuanceId: string, options: IssuerOptions) {
    this.client = client
    this.wallet = wallet
    this.issuanceId = issuanceId
    this.#banRegistry = options.banRegistry
  }

  get issuer(): string {
    return this.wallet.classicAddress
  }

  /**
   * Create a new issuance with allow-listing, locking and clawback enabled, and
   * escrow, trading and confidential balances disabled. These capability flags
   * are fixed at creation on networks without the DynamicMPT amendment.
   */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    create: CreateIssuanceOptions,
    options: IssuerOptions,
  ): Promise<MptIssuer> {
    const transferable = create.transferable ?? true
    if (create.transferFee !== undefined) {
      if (!Number.isInteger(create.transferFee) || create.transferFee < 0 || create.transferFee > 50_000) {
        throw new MptIssuerError('transferFee must be an integer between 0 and 50000')
      }
      if (create.transferFee > 0 && !transferable) {
        throw new MptIssuerError('transferFee requires a transferable token')
      }
    }
    const assetScale = create.assetScale ?? 0
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 19) {
      throw new MptIssuerError('assetScale must be an integer between 0 and 19')
    }

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (transferable) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const { meta } = await submitTransaction(client, wallet, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      Flags: flags,
      AssetScale: assetScale,
      MPTokenMetadata: encodeMPTokenMetadata(create.metadata),
      ...(create.maximumAmount !== undefined && {
        MaximumAmount: parseBaseUnits(create.maximumAmount).toString(),
      }),
      ...(create.transferFee ? { TransferFee: create.transferFee } : {}),
    })
    const issuanceId = (meta as { mpt_issuance_id?: string }).mpt_issuance_id
    if (!issuanceId) {
      throw new LedgerStateMismatchError('MPTokenIssuanceCreate succeeded but metadata has no mpt_issuance_id')
    }
    return MptIssuer.attach(client, wallet, issuanceId, options)
  }

  /**
   * Manage an existing issuance. Verifies that the wallet is its issuer and that
   * its on-ledger settings support every compliance control.
   */
  static async attach(client: Client, wallet: Wallet, issuanceId: string, options: IssuerOptions): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
      throw new MptIssuerError(`Invalid MPT issuance ID ${JSON.stringify(issuanceId)}`)
    }
    const issuer = new MptIssuer(client, wallet, issuanceId.toUpperCase(), options)
    const status = await issuer.getIssuanceStatus()
    if (status.issuer !== wallet.classicAddress) {
      throw new ComplianceConfigError(`Issuance ${issuanceId} is issued by ${status.issuer}, not ${wallet.classicAddress}`)
    }
    if ((status.flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
      throw new ComplianceConfigError('Issuance must have Can Lock, Require Auth and Can Clawback enabled')
    }
    if ((status.flags & FORBIDDEN_ISSUANCE_FLAGS) !== 0) {
      throw new ComplianceConfigError('Issuance must not allow escrow, DEX trading or confidential balances')
    }
    if (status.domainId !== undefined) {
      // A permissioned domain authorizes holders by credential, bypassing the issuer's allowlist and bans.
      throw new ComplianceConfigError('Issuance must not use a permissioned domain (DomainID)')
    }
    return issuer
  }

  // ---------------------------------------------------------------- reads

  async getIssuanceStatus(): Promise<IssuanceStatus> {
    let node: LedgerEntry.MPTokenIssuance
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mpt_issuance: this.issuanceId,
        ledger_index: 'validated',
      })
      node = response.result.node as unknown as LedgerEntry.MPTokenIssuance
    } catch (error) {
      if (isEntryNotFound(error)) {
        throw new ComplianceConfigError(`MPT issuance ${this.issuanceId} does not exist in the validated ledger`)
      }
      throw error
    }
    const has = (flag: number) => (node.Flags & flag) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: node.Issuer,
      assetScale: node.AssetScale ?? 0,
      outstandingAmount: BigInt(node.OutstandingAmount ?? '0'),
      maximumAmount: node.MaximumAmount === undefined ? undefined : BigInt(node.MaximumAmount),
      globallyFrozen: has(MPTokenIssuanceFlags.lsfMPTLocked),
      canLock: has(MPTokenIssuanceFlags.lsfMPTCanLock),
      requireAuth: has(MPTokenIssuanceFlags.lsfMPTRequireAuth),
      canClawback: has(MPTokenIssuanceFlags.lsfMPTCanClawback),
      canTransfer: has(MPTokenIssuanceFlags.lsfMPTCanTransfer),
      canEscrow: has(MPTokenIssuanceFlags.lsfMPTCanEscrow),
      canTrade: has(MPTokenIssuanceFlags.lsfMPTCanTrade),
      domainId: node.DomainID,
      flags: node.Flags,
    }
  }

  async getHolderStatus(address: string): Promise<HolderStatus> {
    assertAddress(address)
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.issuanceId, account: address },
        ledger_index: 'validated',
      })
      const node = response.result.node as unknown as LedgerEntry.MPToken
      return {
        address,
        optedIn: true,
        approved: (node.Flags & lsfMPTAuthorized) !== 0,
        frozen: (node.Flags & lsfMPTLocked) !== 0,
        // MPTAmount is a default field: the ledger omits it when zero.
        balance: BigInt(node.MPTAmount ?? '0'),
        escrowed: BigInt(node.LockedAmount ?? '0'),
      }
    } catch (error) {
      if (isEntryNotFound(error)) {
        return { address, optedIn: false, approved: false, frozen: false, balance: 0n, escrowed: 0n }
      }
      throw error
    }
  }

  isBanned(address: string): Promise<boolean> {
    return this.#banRegistry.isBanned(this.issuanceId, address)
  }

  /**
   * Dry-run a payment of this token with the `simulate` RPC and return the
   * engine result code (e.g. "tesSUCCESS", "tecLOCKED", "tecNO_AUTH").
   * Nothing is signed or submitted.
   */
  async simulatePayment(from: string, to: string, amount: BaseUnits): Promise<string> {
    assertAddress(from, 'sender')
    assertAddress(to, 'destination')
    const response = await this.client.simulate({
      TransactionType: 'Payment',
      Account: from,
      Destination: to,
      Amount: this.#amount(parseBaseUnits(amount)),
    })
    return response.result.engine_result
  }

  // ------------------------------------------------------------- allowlist

  /**
   * Allow-list a holder after KYC. The holder must already have opted in.
   * Refuses banned addresses. Idempotent.
   */
  async approveHolder(address: string): Promise<TxReceipt | undefined> {
    await this.#assertNotBanned(address)
    const status = await this.getHolderStatus(address)
    if (!status.optedIn) throw new HolderNotOptedInError(address)
    if (status.approved) return undefined
    return this.#submit(
      {
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuer,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      },
      // Re-check inside the submission queue so a ban recorded meanwhile wins.
      () => this.#assertNotBanned(address),
    )
  }

  /** Remove a holder from the allowlist without banning them. Idempotent. */
  async revokeApproval(address: string): Promise<TxReceipt | undefined> {
    this.#assertHolderAddress(address)
    const status = await this.getHolderStatus(address)
    if (!status.optedIn || !status.approved) return undefined
    return this.#unauthorize(address)
  }

  // --------------------------------------------------------------- supply

  /**
   * Issue (mint) tokens to an approved holder. Amount is in base units.
   *
   * The ledger lets an issuer pay a holder even while that holder, or the whole
   * token, is locked, so freezes are enforced here before submitting. The check
   * runs inside the submission queue, after any earlier freeze or ban from this
   * instance has validated.
   */
  async issue(to: string, amount: BaseUnits): Promise<TxReceipt> {
    await this.#assertNotBanned(to)
    const value = parseBaseUnits(amount)
    const precheck = async () => {
      await this.#assertNotBanned(to)
      const [issuance, holder] = await Promise.all([this.getIssuanceStatus(), this.getHolderStatus(to)])
      if (issuance.globallyFrozen) throw new FrozenError('The token is globally frozen')
      if (!holder.approved) throw new HolderNotApprovedError(to)
      if (holder.frozen) throw new FrozenError(`${to} is frozen`)
    }
    const { hash, ledgerIndex, meta } = await this.#submitWithMeta(
      {
        TransactionType: 'Payment',
        Account: this.issuer,
        Destination: to,
        Amount: this.#amount(value),
      },
      precheck,
    )
    // Partial payments are never requested, but verify rather than assume.
    const delivered = meta.delivered_amount as MPTAmount | undefined
    if (
      typeof delivered !== 'object' ||
      delivered.mpt_issuance_id.toUpperCase() !== this.issuanceId ||
      BigInt(delivered.value) !== value
    ) {
      throw new LedgerStateMismatchError(`Payment ${hash} delivered ${JSON.stringify(delivered)}, expected ${value}`)
    }
    return { hash, ledgerIndex }
  }

  // ------------------------------------------------------------- clawback

  /**
   * Claw back tokens from any holder, regardless of approval or freeze state.
   * If `amount` exceeds the balance the ledger claws back the whole balance;
   * the receipt reports the amount actually removed.
   */
  async clawback(holder: string, amount: BaseUnits): Promise<ClawbackReceipt> {
    this.#assertHolderAddress(holder)
    const requested = parseBaseUnits(amount)
    const { hash, ledgerIndex, meta } = await this.#submitWithMeta({
      TransactionType: 'Clawback',
      Account: this.issuer,
      Amount: this.#amount(requested),
      Holder: holder,
    })
    const node = findModifiedNode(
      meta,
      'MPToken',
      (f) => f.Account === holder && String(f.MPTokenIssuanceID).toUpperCase() === this.issuanceId,
    )
    const before = node?.PreviousFields?.MPTAmount
    if (node === undefined || before === undefined) {
      throw new LedgerStateMismatchError(`Clawback ${hash} did not change ${holder}'s balance`)
    }
    const after = node.FinalFields?.MPTAmount ?? '0'
    return { hash, ledgerIndex, requested, clawedBack: BigInt(before as string) - BigInt(after as string) }
  }

  // --------------------------------------------------------------- freezes

  /** Lock one holder: they can no longer send or receive (except paying the issuer). */
  freezeHolder(address: string): Promise<TxReceipt> {
    this.#assertHolderAddress(address)
    return this.#setLock(MPTokenIssuanceSetFlags.tfMPTLock, address)
  }

  unfreezeHolder(address: string): Promise<TxReceipt> {
    this.#assertHolderAddress(address)
    return this.#setLock(MPTokenIssuanceSetFlags.tfMPTUnlock, address)
  }

  /** Lock every balance of the token (incident response). */
  freezeAll(): Promise<TxReceipt> {
    return this.#setLock(MPTokenIssuanceSetFlags.tfMPTLock)
  }

  unfreezeAll(): Promise<TxReceipt> {
    return this.#setLock(MPTokenIssuanceSetFlags.tfMPTUnlock)
  }

  // ------------------------------------------------------------------ bans

  /**
   * Ban an address permanently:
   *   1. record the ban (so no concurrent or later approval/issuance can succeed),
   *   2. remove it from the allowlist (it can no longer receive the token),
   *   3. lock its MPToken (defence in depth, e.g. if the allowlist is changed by mistake),
   *   4. claw back its entire balance,
   *   5. verify on the validated ledger that it holds nothing and is not approved.
   * Safe to re-run: every step is skipped if already in effect.
   */
  async banHolder(address: string, reason: string): Promise<BanReport> {
    this.#assertHolderAddress(address)
    if (!reason.trim()) throw new MptIssuerError('A ban reason is required for the audit trail')
    await this.#banRegistry.recordBan({
      address,
      issuanceId: this.issuanceId,
      reason,
      bannedAt: new Date().toISOString(),
    })

    const steps: BanReport['steps'] = []
    let clawedBack = 0n
    let status = await this.getHolderStatus(address)

    if (status.optedIn) {
      if (status.approved) {
        steps.push({ action: 'unauthorize', hash: (await this.#unauthorize(address)).hash })
      }
      if (!status.frozen) {
        steps.push({ action: 'freeze', hash: (await this.freezeHolder(address)).hash })
      }
      // Re-read: the holder may have paid some back to the issuer in the meantime.
      status = await this.getHolderStatus(address)
      if (status.balance > 0n) {
        try {
          const receipt = await this.clawback(address, status.balance)
          clawedBack = receipt.clawedBack
          steps.push({ action: 'clawback', hash: receipt.hash })
        } catch (error) {
          // Balance reached zero between the read and the clawback: nothing left to take.
          if (!(error instanceof TransactionFailedError && error.resultCode === 'tecINSUFFICIENT_FUNDS')) throw error
        }
      }
      status = await this.getHolderStatus(address)
    }

    if (status.balance !== 0n || status.escrowed !== 0n || status.approved) {
      throw new LedgerStateMismatchError(
        `Ban of ${address} incomplete: balance=${status.balance} escrowed=${status.escrowed} approved=${status.approved}`,
      )
    }
    return { address, steps, clawedBack, finalStatus: status }
  }

  // --------------------------------------------------------------- private

  #amount(value: bigint): MPTAmount {
    return { mpt_issuance_id: this.issuanceId, value: value.toString() }
  }

  #assertHolderAddress(address: string): void {
    assertAddress(address)
    if (address === this.issuer) throw new MptIssuerError('The issuer cannot be a holder of its own token')
  }

  async #assertNotBanned(address: string): Promise<void> {
    this.#assertHolderAddress(address)
    if (await this.isBanned(address)) throw new BannedHolderError(address)
  }

  #unauthorize(address: string): Promise<TxReceipt> {
    return this.#submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
  }

  #setLock(flag: MPTokenIssuanceSetFlags, holder?: string): Promise<TxReceipt> {
    return this.#submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer,
      MPTokenIssuanceID: this.issuanceId,
      Flags: flag,
      ...(holder !== undefined && { Holder: holder }),
    })
  }

  async #submit(tx: SubmittableTransaction, precheck?: () => Promise<void>): Promise<TxReceipt> {
    const { hash, ledgerIndex } = await this.#submitWithMeta(tx, precheck)
    return { hash, ledgerIndex }
  }

  /**
   * Serialize submissions from this issuer so autofilled sequence numbers never
   * collide, and so a precheck sees the result of every earlier submission.
   */
  #submitWithMeta(tx: SubmittableTransaction, precheck?: () => Promise<void>): ReturnType<typeof submitTransaction> {
    const run = this.#queue.then(async () => {
      await precheck?.()
      return submitTransaction(this.client, this.wallet, tx)
    })
    this.#queue = run.catch(() => undefined)
    return run
  }
}
