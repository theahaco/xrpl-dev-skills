import {
  type Client,
  LedgerEntry,
  type MPTokenMetadata,
  type Node,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
} from 'xrpl'

import { fromBaseUnits, toBaseUnits, toPositiveBaseUnits } from './amount.js'
import type { BanList, BanRecord } from './banList.js'
import { ComplianceError } from './errors.js'
import { type Logger, silentLogger, TransactionSubmitter, type ValidatedTransaction } from './submitter.js'

const { MPTokenIssuanceFlags } = LedgerEntry

/**
 * Flags on an `MPToken` ledger entry (a holder's balance). xrpl.js does not
 * export these, so they are defined here from the xrpl.org MPToken reference.
 */
export const MPTokenFlags = {
  lsfMPTLocked: 0x00000001,
  lsfMPTAuthorized: 0x00000002,
} as const

/**
 * Capabilities every issuance managed by this module must have. Without
 * DynamicMPT (not enabled on testnet as of 2026-09-29) these can only be set
 * when the issuance is created, never added afterwards.
 */
export const REQUIRED_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanLock |
  MPTokenIssuanceFlags.lsfMPTRequireAuth |
  MPTokenIssuanceFlags.lsfMPTCanTransfer |
  MPTokenIssuanceFlags.lsfMPTCanClawback

/**
 * Capabilities that must stay off. Escrowed MPT balances are held outside the
 * holder's clawable balance, so escrow would let a holder shield tokens from a
 * ban. DEX trading is not part of this product.
 */
export const FORBIDDEN_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanEscrow |
  MPTokenIssuanceFlags.lsfMPTCanTrade |
  MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  /** Supply cap in token units, if one was set. */
  maximumAmount: string | undefined
  /** Tokens in circulation, in token units. */
  outstandingAmount: string
  globallyFrozen: boolean
  canLock: boolean
  requireAuth: boolean
  canTransfer: boolean
  canClawback: boolean
  canEscrow: boolean
  canTrade: boolean
}

export interface HolderState {
  address: string
  /** The holder has created an MPToken entry (opted in to hold the token). */
  optedIn: boolean
  /** The issuer has authorized (allowlisted) this holder. */
  approved: boolean
  /** The holder's balance is individually locked. */
  frozen: boolean
  /** Present in the ban list. */
  banned: boolean
  /** Balance in token units. */
  balance: string
  balanceBaseUnits: bigint
}

export interface OperationResult {
  /** False when the ledger was already in the requested state and nothing was submitted. */
  changed: boolean
  /** Hashes of the validated transactions this operation submitted, in order. */
  transactionHashes: string[]
}

export interface ClawbackResult extends OperationResult {
  /** Amount actually removed from the holder, in token units (read from transaction metadata). */
  clawedBack: string
}

export interface BanResult extends OperationResult {
  record: BanRecord
  clawedBack: string
  /** False if the holder never opted in; the ban list alone then blocks them. */
  holderHadMPToken: boolean
}

export interface CreateIssuanceOptions {
  /** Decimal places. One whole token = 10^assetScale base units. */
  assetScale: number
  /** Optional supply cap, in token units. */
  maximumAmount?: string
  /** XLS-89 metadata. Encoded and size-checked (1024 bytes max) by xrpl.js. */
  metadata: MPTokenMetadata
}

export interface IssuerDependencies {
  banList: BanList
  logger?: Logger
}

/**
 * Issuer-side controls for one regulated MPT issuance.
 *
 * Every mutating method runs exclusively (one at a time per instance), reads
 * validated ledger state, applies the compliance guards, and waits for the
 * transaction to be validated. Methods are idempotent where it makes sense:
 * freezing an already-frozen holder submits nothing and returns
 * `changed: false`.
 *
 * Run only one instance per issuance across the whole backend, or add
 * external locking. Two instances would race on the issuer's account
 * Sequence and on the guard checks.
 */
export class MptIssuer {
  readonly issuanceId: string
  readonly assetScale: number
  readonly #client: Client
  readonly #issuerAddress: string
  readonly #submitter: TransactionSubmitter
  readonly #banList: BanList
  readonly #logger: Logger
  #exclusiveChain: Promise<unknown> = Promise.resolve()

  private constructor(
    client: Client,
    wallet: Wallet,
    issuanceId: string,
    assetScale: number,
    deps: IssuerDependencies,
  ) {
    this.#client = client
    this.#issuerAddress = wallet.classicAddress
    this.issuanceId = issuanceId
    this.assetScale = assetScale
    this.#banList = deps.banList
    this.#logger = deps.logger ?? silentLogger
    this.#submitter = new TransactionSubmitter(client, wallet, { logger: this.#logger })
  }

  get issuerAddress(): string {
    return this.#issuerAddress
  }

  /** Creates a new issuance with all compliance controls enabled and returns a manager for it. */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    options: CreateIssuanceOptions,
    deps: IssuerDependencies,
  ): Promise<MptIssuer> {
    const logger = deps.logger ?? silentLogger
    const tx: SubmittableTransaction = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: options.assetScale,
      TransferFee: 0,
      MPTokenMetadata: encodeMPTokenMetadata(options.metadata),
      Flags:
        MPTokenIssuanceCreateFlags.tfMPTCanLock |
        MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanTransfer |
        MPTokenIssuanceCreateFlags.tfMPTCanClawback,
      ...(options.maximumAmount === undefined
        ? {}
        : { MaximumAmount: toPositiveBaseUnits(options.maximumAmount, options.assetScale).toString() }),
    }
    const submitter = new TransactionSubmitter(client, wallet, { logger })
    const result = await submitter.submit(tx)
    const issuanceId = (result.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    if (issuanceId === undefined) {
      throw new Error(`MPTokenIssuanceCreate ${result.hash} succeeded but metadata has no mpt_issuance_id`)
    }
    logger.info('issuance.created', { issuanceId, hash: result.hash })
    return MptIssuer.connect(client, wallet, issuanceId, deps)
  }

  /**
   * Attaches to an existing issuance. Checks that `wallet` is its issuer and
   * that the issuance has the required controls (and none of the forbidden
   * capabilities).
   */
  static async connect(
    client: Client,
    wallet: Wallet,
    issuanceId: string,
    deps: IssuerDependencies,
  ): Promise<MptIssuer> {
    const entry = await readIssuanceEntry(client, issuanceId)
    if (entry.Issuer !== wallet.classicAddress) {
      throw new ComplianceError(
        'ISSUANCE_MISCONFIGURED',
        `Issuance ${issuanceId} is issued by ${entry.Issuer}, not ${wallet.classicAddress}`,
      )
    }
    const missing = REQUIRED_ISSUANCE_FLAGS & ~entry.Flags
    if (missing !== 0) {
      throw new ComplianceError(
        'ISSUANCE_MISCONFIGURED',
        `Issuance ${issuanceId} lacks required capability flags 0x${missing.toString(16)}`,
      )
    }
    const forbidden = FORBIDDEN_ISSUANCE_FLAGS & entry.Flags
    if (forbidden !== 0) {
      throw new ComplianceError(
        'ISSUANCE_MISCONFIGURED',
        `Issuance ${issuanceId} has forbidden capability flags 0x${forbidden.toString(16)}`,
      )
    }
    return new MptIssuer(client, wallet, issuanceId, entry.AssetScale ?? 0, deps)
  }

  // ---------------------------------------------------------------- reads

  async getIssuance(): Promise<IssuanceState> {
    const entry = await readIssuanceEntry(this.#client, this.issuanceId)
    const has = (flag: number): boolean => (entry.Flags & flag) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: entry.Issuer,
      assetScale: entry.AssetScale ?? 0,
      maximumAmount:
        entry.MaximumAmount === undefined ? undefined : fromBaseUnits(entry.MaximumAmount, this.assetScale),
      outstandingAmount: fromBaseUnits(entry.OutstandingAmount, this.assetScale),
      globallyFrozen: has(MPTokenIssuanceFlags.lsfMPTLocked),
      canLock: has(MPTokenIssuanceFlags.lsfMPTCanLock),
      requireAuth: has(MPTokenIssuanceFlags.lsfMPTRequireAuth),
      canTransfer: has(MPTokenIssuanceFlags.lsfMPTCanTransfer),
      canClawback: has(MPTokenIssuanceFlags.lsfMPTCanClawback),
      canEscrow: has(MPTokenIssuanceFlags.lsfMPTCanEscrow),
      canTrade: has(MPTokenIssuanceFlags.lsfMPTCanTrade),
    }
  }

  async getHolder(address: string): Promise<HolderState> {
    this.#assertHolderAddress(address)
    const [token, banned] = await Promise.all([this.#readMPToken(address), this.#banList.isBanned(address)])
    const balanceBaseUnits = BigInt(token?.MPTAmount ?? '0')
    return {
      address,
      optedIn: token !== undefined,
      approved: token !== undefined && (token.Flags & MPTokenFlags.lsfMPTAuthorized) !== 0,
      frozen: token !== undefined && (token.Flags & MPTokenFlags.lsfMPTLocked) !== 0,
      banned,
      balance: fromBaseUnits(balanceBaseUnits, this.assetScale),
      balanceBaseUnits,
    }
  }

  async isBanned(address: string): Promise<boolean> {
    return this.#banList.isBanned(address)
  }

  // ------------------------------------------------------------- allowlist

  /**
   * Approves (allowlists) a holder after KYC. The holder must first opt in
   * by submitting their own MPTokenAuthorize. Banned addresses are refused.
   */
  approveHolder(address: string): Promise<OperationResult> {
    return this.#exclusive(async () => {
      const holder = await this.getHolder(address)
      this.#assertNotBanned(holder)
      this.#assertOptedIn(holder)
      if (holder.approved) {
        return unchanged()
      }
      const result = await this.#submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.#issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
      this.#audit('holder.approved', { holder: address, hash: result.hash })
      return changed(result)
    })
  }

  /**
   * Removes a holder from the allowlist. An unapproved holder can neither
   * send nor receive the token, but keeps any existing balance. Use `ban` to
   * also remove the balance.
   */
  revokeApproval(address: string): Promise<OperationResult> {
    return this.#exclusive(async () => this.#revokeApproval(await this.getHolder(address)))
  }

  // ------------------------------------------------------------- issuance

  /**
   * Sends newly issued tokens to an approved holder.
   *
   * The ledger lets an issuer pay a locked holder, and pay anyone during a
   * global lock (a lock only blocks holder-to-holder transfers). A frozen
   * holder must not receive tokens, so this method checks both freezes
   * before submitting.
   */
  issue(address: string, amount: string): Promise<ValidatedTransaction> {
    return this.#exclusive(async () => {
      const units = toPositiveBaseUnits(amount, this.assetScale)
      const [holder, issuance] = await Promise.all([this.getHolder(address), this.getIssuance()])
      this.#assertNotBanned(holder)
      this.#assertOptedIn(holder)
      if (!holder.approved) {
        throw new ComplianceError('HOLDER_NOT_APPROVED', `${address} is not approved to hold this token`)
      }
      if (holder.frozen) {
        throw new ComplianceError('HOLDER_FROZEN', `${address} is frozen`)
      }
      if (issuance.globallyFrozen) {
        throw new ComplianceError('GLOBALLY_FROZEN', 'The token is globally frozen')
      }
      const result = await this.#submit({
        TransactionType: 'Payment',
        Account: this.#issuerAddress,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
      })
      const delivered = deliveredBaseUnits(result.meta, this.issuanceId)
      if (delivered !== units) {
        // Unreachable without tfPartialPayment, but never report the wrong amount.
        throw new Error(`Issued ${units} base units to ${address} but ${String(delivered)} were delivered (${result.hash})`)
      }
      this.#audit('tokens.issued', { holder: address, amount, hash: result.hash })
      return result
    })
  }

  // -------------------------------------------------------------- clawback

  /**
   * Claws back `amount` tokens from a holder. If the holder has less, the
   * ledger claws back their whole balance; `clawedBack` reports the actual
   * amount. Works on frozen and unapproved holders.
   */
  clawback(address: string, amount: string): Promise<ClawbackResult> {
    return this.#exclusive(async () => {
      const units = toPositiveBaseUnits(amount, this.assetScale)
      return this.#clawback(await this.getHolder(address), units)
    })
  }

  /** Claws back a holder's entire balance. */
  clawbackAll(address: string): Promise<ClawbackResult> {
    return this.#exclusive(async () => {
      const holder = await this.getHolder(address)
      return this.#clawback(holder, holder.balanceBaseUnits)
    })
  }

  // ---------------------------------------------------------------- freeze

  /** Locks one holder: they can no longer send to or receive from other holders, or receive from the issuer. */
  freezeHolder(address: string): Promise<OperationResult> {
    return this.#exclusive(async () => this.#setHolderLock(await this.getHolder(address), true))
  }

  /** Unlocks one holder. Refused for banned holders, which stay frozen. */
  unfreezeHolder(address: string): Promise<OperationResult> {
    return this.#exclusive(async () => {
      const holder = await this.getHolder(address)
      this.#assertNotBanned(holder)
      return this.#setHolderLock(holder, false)
    })
  }

  /** Globally freezes the token: no holder-to-holder transfers, and `issue` is refused. */
  freezeAll(): Promise<OperationResult> {
    return this.#exclusive(async () => this.#setGlobalLock(true))
  }

  /** Lifts the global freeze. Individually frozen holders stay frozen. */
  unfreezeAll(): Promise<OperationResult> {
    return this.#exclusive(async () => this.#setGlobalLock(false))
  }

  // ------------------------------------------------------------------- ban

  /**
   * Bans an address. The steps run in this order, and each one is skipped if
   * already done, so a partially completed ban can be retried safely:
   *
   * 1. Record the ban in the ban list (fail-closed: from here on, approve,
   *    issue and unfreeze are refused for this address).
   * 2. Freeze the holder, so they can't move tokens to someone else while the
   *    ban is in progress.
   * 3. Claw back their entire balance (clawback ignores freezes).
   * 4. Revoke their approval. With RequireAuth on the issuance, the ledger
   *    then rejects any payment to them with `tecNO_AUTH`, including after
   *    they delete and re-create their MPToken entry.
   *
   * Finally it re-reads the ledger and checks that the balance is zero and
   * the holder is unapproved.
   */
  ban(address: string, reason: string): Promise<BanResult> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      if (reason.trim().length === 0) {
        throw new RangeError('A ban reason is required for the audit trail')
      }
      await this.#banList.add({ address, reason, bannedAt: new Date().toISOString() })
      const record = await this.#banList.get(address)
      if (record === undefined) {
        throw new Error(`Ban list did not persist ${address}`)
      }
      this.#audit('holder.ban_recorded', { holder: address, reason: record.reason })
      return this.#enforceBan(record)
    })
  }

  /**
   * Re-applies every ban in the ban list. For example, it re-freezes a banned
   * holder who deleted and re-created their MPToken entry. Safe to run
   * periodically.
   */
  enforceBans(): Promise<BanResult[]> {
    return this.#exclusive(async () => {
      const results: BanResult[] = []
      for (const record of await this.#banList.list()) {
        results.push(await this.#enforceBan(record))
      }
      return results
    })
  }

  // -------------------------------------------------------------- internals

  async #enforceBan(record: BanRecord): Promise<BanResult> {
    const address = record.address
    const hashes: string[] = []
    let clawedBack = 0n
    const initial = await this.getHolder(address)
    if (initial.optedIn) {
      hashes.push(...(await this.#setHolderLock(initial, true)).transactionHashes)
      if (initial.balanceBaseUnits > 0n) {
        const claw = await this.#clawback(initial, initial.balanceBaseUnits)
        hashes.push(...claw.transactionHashes)
        clawedBack = toBaseUnits(claw.clawedBack, this.assetScale)
      }
      hashes.push(...(await this.#revokeApproval(await this.getHolder(address))).transactionHashes)
    }

    const final = await this.getHolder(address)
    if (final.balanceBaseUnits !== 0n || final.approved) {
      throw new Error(
        `Ban of ${address} incomplete: balance ${final.balance}, approved ${String(final.approved)}`,
      )
    }
    this.#audit('holder.ban_enforced', {
      holder: address,
      clawedBack: fromBaseUnits(clawedBack, this.assetScale),
      hashes,
    })
    return {
      record,
      changed: hashes.length > 0,
      transactionHashes: hashes,
      clawedBack: fromBaseUnits(clawedBack, this.assetScale),
      holderHadMPToken: initial.optedIn,
    }
  }

  async #revokeApproval(holder: HolderState): Promise<OperationResult> {
    if (!holder.optedIn || !holder.approved) {
      return unchanged()
    }
    const result = await this.#submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.#issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder.address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    this.#audit('holder.approval_revoked', { holder: holder.address, hash: result.hash })
    return changed(result)
  }

  async #clawback(holder: HolderState, units: bigint): Promise<ClawbackResult> {
    if (!holder.optedIn || holder.balanceBaseUnits === 0n || units === 0n) {
      return { ...unchanged(), clawedBack: '0' }
    }
    const result = await this.#submit({
      TransactionType: 'Clawback',
      Account: this.#issuerAddress,
      Holder: holder.address,
      Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
    })
    const removed = holderBalanceDecrease(result.meta, this.issuanceId, holder.address)
    const clawedBack = fromBaseUnits(removed, this.assetScale)
    this.#audit('tokens.clawed_back', { holder: holder.address, clawedBack, hash: result.hash })
    return { ...changed(result), clawedBack }
  }

  async #setHolderLock(holder: HolderState, lock: boolean): Promise<OperationResult> {
    this.#assertOptedIn(holder)
    if (holder.frozen === lock) {
      return unchanged()
    }
    const result = await this.#submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.#issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder.address,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.#audit(lock ? 'holder.frozen' : 'holder.unfrozen', { holder: holder.address, hash: result.hash })
    return changed(result)
  }

  async #setGlobalLock(lock: boolean): Promise<OperationResult> {
    const issuance = await this.getIssuance()
    if (issuance.globallyFrozen === lock) {
      return unchanged()
    }
    const result = await this.#submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.#issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    this.#audit(lock ? 'token.globally_frozen' : 'token.globally_unfrozen', { hash: result.hash })
    return changed(result)
  }

  #submit(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    return this.#submitter.submit(tx)
  }

  async #readMPToken(address: string): Promise<LedgerEntry.MPToken | undefined> {
    try {
      const response = await this.#client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.issuanceId, account: address },
        ledger_index: 'validated',
      })
      return response.result.node as unknown as LedgerEntry.MPToken
    } catch (error) {
      if (isEntryNotFound(error)) {
        return undefined
      }
      throw error
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#exclusiveChain.then(operation)
    this.#exclusiveChain = run.catch(() => undefined)
    return run
  }

  #assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) {
      throw new ComplianceError('INVALID_HOLDER', `"${address}" is not a valid classic address`)
    }
    if (address === this.#issuerAddress) {
      throw new ComplianceError('INVALID_HOLDER', 'The issuer cannot be a holder of its own token')
    }
  }

  #assertNotBanned(holder: HolderState): void {
    if (holder.banned) {
      throw new ComplianceError('HOLDER_BANNED', `${holder.address} is banned`)
    }
  }

  #assertOptedIn(holder: HolderState): void {
    if (!holder.optedIn) {
      throw new ComplianceError(
        'HOLDER_NOT_OPTED_IN',
        `${holder.address} has not opted in to hold this token (no MPToken entry)`,
      )
    }
  }

  #audit(event: string, fields: Record<string, unknown>): void {
    this.#logger.info(event, { issuanceId: this.issuanceId, ...fields })
  }
}

// ------------------------------------------------------------------ helpers

function unchanged(): OperationResult {
  return { changed: false, transactionHashes: [] }
}

function changed(result: ValidatedTransaction): OperationResult {
  return { changed: true, transactionHashes: [result.hash] }
}

function isEntryNotFound(error: unknown): boolean {
  return (error as { data?: { error?: string } } | undefined)?.data?.error === 'entryNotFound'
}

async function readIssuanceEntry(client: Client, issuanceId: string): Promise<LedgerEntry.MPTokenIssuance> {
  if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
    throw new RangeError(`"${issuanceId}" is not a valid MPT issuance ID (48 hex characters)`)
  }
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    return response.result.node as LedgerEntry.MPTokenIssuance
  } catch (error) {
    if (isEntryNotFound(error)) {
      throw new ComplianceError('ISSUANCE_MISCONFIGURED', `MPT issuance ${issuanceId} does not exist`)
    }
    throw error
  }
}

function deliveredBaseUnits(meta: TransactionMetadata, issuanceId: string): bigint | undefined {
  const delivered = (meta as { delivered_amount?: unknown }).delivered_amount
  if (
    typeof delivered === 'object' &&
    delivered !== null &&
    'mpt_issuance_id' in delivered &&
    'value' in delivered &&
    delivered.mpt_issuance_id === issuanceId &&
    typeof delivered.value === 'string'
  ) {
    return BigInt(delivered.value)
  }
  return undefined
}

/**
 * How much a holder's MPToken balance went down in a transaction, read from
 * the metadata. A balance of zero is left out of FinalFields, so a missing
 * field counts as 0.
 */
function holderBalanceDecrease(meta: TransactionMetadata, issuanceId: string, holder: string): bigint {
  for (const node of meta.AffectedNodes as Node[]) {
    if (!('ModifiedNode' in node)) {
      continue
    }
    const modified = node.ModifiedNode
    const fields = modified.FinalFields
    if (
      modified.LedgerEntryType !== 'MPToken' ||
      fields?.['Account'] !== holder ||
      fields['MPTokenIssuanceID'] !== issuanceId
    ) {
      continue
    }
    const before = BigInt((modified.PreviousFields?.['MPTAmount'] as string | undefined) ?? '0')
    const after = BigInt((fields['MPTAmount'] as string | undefined) ?? '0')
    return before - after
  }
  throw new Error(`Transaction metadata has no balance change for ${holder}`)
}
