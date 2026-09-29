/**
 * Issuer-side compliance controls for a regulated Multi-Purpose Token (MPT).
 *
 * Control -> ledger mechanism:
 *   Allowlist        MPTokenIssuance `lsfMPTRequireAuth` + issuer `MPTokenAuthorize` per holder
 *   Clawback         `Clawback` transaction (issuance has `lsfMPTCanClawback`)
 *   Per-holder freeze `MPTokenIssuanceSet` with `Holder` + `tfMPTLock` / `tfMPTUnlock`
 *   Global freeze    `MPTokenIssuanceSet` without `Holder` + `tfMPTLock` / `tfMPTUnlock`
 *   Ban              ban registry + lock + revoke authorization + claw back entire balance
 *
 * Ledger behaviour this module compensates for (verified on testnet, rippled 3.4.1):
 *   - A payment *from the issuer* to an individually locked holder, or while the
 *     issuance is globally locked, succeeds on-ledger. `issue()` therefore refuses
 *     to send to a frozen holder or while globally frozen.
 *   - A locked holder can still send tokens back to the issuer (redemption). This is
 *     protocol behaviour and cannot be blocked by the issuer.
 *   - A holder with a zero balance can delete their MPToken entry (clearing any lock)
 *     and create a new one. The new entry is unauthorized, so Require Auth still stops
 *     it receiving tokens; the ban registry stops it being approved again.
 *
 * Concurrency: every mutating call runs under a per-instance mutex so that its
 * pre-flight checks and its transactions are not interleaved with another call.
 * Run a single MptIssuer instance per issuer account (or wrap calls in a distributed
 * lock), otherwise concurrent submissions will race on the account sequence.
 */

import {
  type Client,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  RippledError,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  validateMPTokenMetadata,
} from 'xrpl'

import { MAX_MPT_BASE_UNITS, assertValidAssetScale, fromBaseUnits, parseLedgerAmount, toBaseUnits } from './amounts.js'
import type { BanRegistry } from './banRegistry.js'
import { ComplianceError, InvalidInputError, TransactionFailedError } from './errors.js'

/** `MPTokenIssuance` ledger-entry flags. */
const lsfIssuance = {
  locked: 0x01,
  canLock: 0x02,
  requireAuth: 0x04,
  canEscrow: 0x08,
  canTrade: 0x10,
  canTransfer: 0x20,
  canClawback: 0x40,
  canHoldConfidentialBalance: 0x80,
} as const

/** `MPToken` ledger-entry flags. */
const lsfMPToken = {
  locked: 0x01,
  authorized: 0x02,
} as const

/** Capabilities every issuance managed by this module must have. */
const REQUIRED_ISSUANCE_FLAGS = lsfIssuance.canLock | lsfIssuance.requireAuth | lsfIssuance.canClawback

/**
 * Capabilities that would let balances escape the controls above: escrowed and
 * confidential balances are outside the reach of a plain Clawback, which would
 * break the guarantee that a banned holder ends up holding none of the token.
 */
const FORBIDDEN_ISSUANCE_FLAGS = lsfIssuance.canEscrow | lsfIssuance.canHoldConfidentialBalance

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

const silentLogger: Logger = { info: () => {}, warn: () => {} }

export interface MptIssuerOptions {
  /** A connected xrpl.js client. The caller owns its lifecycle. */
  readonly client: Client
  /** The issuer's signing wallet. */
  readonly wallet: Wallet
  readonly banRegistry: BanRegistry
  /** Refuse to operate unless the connected server reports this network ID (0 = mainnet, 1 = testnet). */
  readonly expectedNetworkId: number
  readonly logger?: Logger
}

export interface CreateIssuanceParams {
  /** Decimal places of the token; e.g. 2 means 1 token = 100 base units. */
  readonly assetScale: number
  /** XLS-89 metadata. Validated strictly; an invalid schema is rejected rather than published. */
  readonly metadata?: MPTokenMetadata
  /** Supply cap in whole-token units (e.g. "1000000"). Omit for the protocol maximum. */
  readonly maximumAmount?: string
  /** Allow holders to transfer between themselves (not just back to the issuer). Default true. */
  readonly transferable?: boolean
  /** Transfer fee in units of 0.001% (0-50000). Requires `transferable`. Default 0. */
  readonly transferFee?: number
}

export interface TxRecord {
  readonly transactionType: string
  readonly hash: string
  readonly ledgerIndex: number
}

export interface ActionResult {
  /** False when the ledger was already in the requested state and nothing was submitted. */
  readonly changed: boolean
  readonly transactions: readonly TxRecord[]
}

export interface ClawbackResult extends ActionResult {
  /** Amount actually removed from the holder, in token units. */
  readonly clawedBack: string
}

export interface BanResult extends ActionResult {
  /** Amount clawed back as part of the ban, in token units ("0" if the holder had nothing). */
  readonly clawedBack: string
}

export interface IssuanceState {
  readonly issuanceId: string
  readonly issuer: string
  readonly assetScale: number
  readonly globallyFrozen: boolean
  readonly outstandingAmount: string
  readonly maximumAmount: string | undefined
  readonly capabilities: {
    readonly canLock: boolean
    readonly requireAuth: boolean
    readonly canClawback: boolean
    readonly canTransfer: boolean
    readonly canTrade: boolean
    readonly canEscrow: boolean
  }
}

export interface HolderState {
  readonly address: string
  /** The holder has an MPToken entry for this issuance (they opted in). */
  readonly optedIn: boolean
  /** The issuer has approved the holder (lsfMPTAuthorized). */
  readonly authorized: boolean
  /** The holder's balance is individually locked (lsfMPTLocked). Does not include the global freeze. */
  readonly frozen: boolean
  /** Recorded in the ban registry. */
  readonly banned: boolean
  /** Balance in token units. */
  readonly balance: string
}

interface RawIssuance {
  readonly Issuer: string
  readonly Flags: number
  readonly AssetScale?: number
  readonly OutstandingAmount?: string
  readonly MaximumAmount?: string
}

interface RawMPToken {
  readonly Flags: number
  readonly MPTAmount?: string
}

interface Submitted {
  readonly record: TxRecord
  readonly meta: TransactionMetadata
}

export class MptIssuer {
  private readonly client: Client
  private readonly wallet: Wallet
  private readonly banRegistry: BanRegistry
  private readonly logger: Logger
  private mutex: Promise<unknown> = Promise.resolve()

  private constructor(
    options: MptIssuerOptions,
    readonly issuanceId: string,
    readonly assetScale: number,
  ) {
    this.client = options.client
    this.wallet = options.wallet
    this.banRegistry = options.banRegistry
    this.logger = options.logger ?? silentLogger
  }

  get issuerAddress(): string {
    return this.wallet.classicAddress
  }

  /**
   * Create a new MPT issuance with every compliance capability enabled
   * (Can Lock, Require Auth, Can Clawback), then attach to it.
   */
  static async createIssuance(
    options: MptIssuerOptions,
    params: CreateIssuanceParams,
  ): Promise<{ issuer: MptIssuer; transaction: TxRecord }> {
    await assertNetwork(options)
    assertValidAssetScale(params.assetScale)
    const transferable = params.transferable ?? true
    const transferFee = params.transferFee ?? 0
    if (!Number.isInteger(transferFee) || transferFee < 0 || transferFee > 50_000) {
      throw new InvalidInputError('transferFee must be an integer between 0 and 50000')
    }
    if (transferFee > 0 && !transferable) {
      throw new InvalidInputError('a non-zero transferFee requires transferable = true')
    }

    let metadataHex: string | undefined
    if (params.metadata) {
      metadataHex = encodeMPTokenMetadata(params.metadata)
      const problems = validateMPTokenMetadata(metadataHex)
      if (problems.length > 0) {
        throw new InvalidInputError(`metadata does not conform to XLS-89: ${problems.join('; ')}`)
      }
    }

    const flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback |
      (transferable ? MPTokenIssuanceCreateFlags.tfMPTCanTransfer : 0)

    const tx: SubmittableTransaction = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: options.wallet.classicAddress,
      Flags: flags,
      AssetScale: params.assetScale,
      ...(transferFee > 0 ? { TransferFee: transferFee } : {}),
      ...(params.maximumAmount !== undefined
        ? { MaximumAmount: toBaseUnits(params.maximumAmount, params.assetScale).toString() }
        : {}),
      ...(metadataHex !== undefined ? { MPTokenMetadata: metadataHex } : {}),
    }

    const logger = options.logger ?? silentLogger
    const { record, meta } = await submit(options.client, options.wallet, tx, logger)
    const issuanceId = (meta as { mpt_issuance_id?: unknown }).mpt_issuance_id
    if (typeof issuanceId !== 'string' || !/^[0-9A-F]{48}$/i.test(issuanceId)) {
      throw new TransactionFailedError(
        'MPTokenIssuanceCreate succeeded but its metadata has no mpt_issuance_id',
        'MPTokenIssuanceCreate',
        'tesSUCCESS',
        record.hash,
      )
    }
    logger.info('MPT issuance created', { issuanceId, hash: record.hash })
    const issuer = await MptIssuer.attach(options, issuanceId)
    return { issuer, transaction: record }
  }

  /**
   * Attach to an existing issuance. Verifies the network, that the wallet is the
   * issuance's issuer, and that the issuance has the required compliance capabilities.
   */
  static async attach(options: MptIssuerOptions, issuanceId: string): Promise<MptIssuer> {
    await assertNetwork(options)
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
      throw new InvalidInputError(`issuanceId must be a 48-character hex string, got ${JSON.stringify(issuanceId)}`)
    }
    const id = issuanceId.toUpperCase()
    const issuance = await readIssuance(options.client, id)
    if (!issuance) {
      throw new ComplianceError('ISSUANCE_NOT_FOUND', `MPT issuance ${id} does not exist in the validated ledger`)
    }
    if (issuance.Issuer !== options.wallet.classicAddress) {
      throw new ComplianceError(
        'ISSUANCE_MISCONFIGURED',
        `MPT issuance ${id} is issued by ${issuance.Issuer}, not by wallet ${options.wallet.classicAddress}`,
      )
    }
    if ((issuance.Flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
      throw new ComplianceError(
        'ISSUANCE_MISCONFIGURED',
        `MPT issuance ${id} lacks a required capability (Can Lock, Require Auth, Can Clawback); flags=0x${issuance.Flags.toString(16)}`,
      )
    }
    if ((issuance.Flags & FORBIDDEN_ISSUANCE_FLAGS) !== 0) {
      throw new ComplianceError(
        'ISSUANCE_MISCONFIGURED',
        `MPT issuance ${id} allows escrow or confidential balances, which clawback cannot reach; flags=0x${issuance.Flags.toString(16)}`,
      )
    }
    return new MptIssuer(options, id, issuance.AssetScale ?? 0)
  }

  // ---------------------------------------------------------------- reads

  async getIssuanceState(): Promise<IssuanceState> {
    const issuance = await this.requireIssuance()
    const has = (flag: number): boolean => (issuance.Flags & flag) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: issuance.Issuer,
      assetScale: this.assetScale,
      globallyFrozen: has(lsfIssuance.locked),
      outstandingAmount: fromBaseUnits(parseLedgerAmount(issuance.OutstandingAmount), this.assetScale),
      maximumAmount:
        issuance.MaximumAmount === undefined
          ? undefined
          : fromBaseUnits(parseLedgerAmount(issuance.MaximumAmount), this.assetScale),
      capabilities: {
        canLock: has(lsfIssuance.canLock),
        requireAuth: has(lsfIssuance.requireAuth),
        canClawback: has(lsfIssuance.canClawback),
        canTransfer: has(lsfIssuance.canTransfer),
        canTrade: has(lsfIssuance.canTrade),
        canEscrow: has(lsfIssuance.canEscrow),
      },
    }
  }

  async getHolderState(address: string): Promise<HolderState> {
    this.assertHolderAddress(address)
    const [token, banned] = await Promise.all([
      readMPToken(this.client, this.issuanceId, address),
      this.banRegistry.isBanned(this.issuanceId, address),
    ])
    return {
      address,
      optedIn: token !== undefined,
      authorized: token !== undefined && (token.Flags & lsfMPToken.authorized) !== 0,
      frozen: token !== undefined && (token.Flags & lsfMPToken.locked) !== 0,
      banned,
      balance: fromBaseUnits(parseLedgerAmount(token?.MPTAmount), this.assetScale),
    }
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Approve a holder (after KYC) to hold the token. The holder must first have
   * opted in by submitting their own MPTokenAuthorize. Banned holders are refused.
   */
  authorizeHolder(address: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      await this.assertNotBanned(address)
      const token = await readMPToken(this.client, this.issuanceId, address)
      if (!token) {
        throw new ComplianceError(
          'HOLDER_NOT_OPTED_IN',
          `${address} has not opted in to ${this.issuanceId}; the holder must submit MPTokenAuthorize first`,
        )
      }
      if ((token.Flags & lsfMPToken.authorized) !== 0) {
        return unchanged()
      }
      const { record } = await this.submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
      await this.expectHolder(address, (s) => s.authorized, 'holder is authorized')
      this.logger.info('holder authorized', { holder: address, hash: record.hash })
      return { changed: true, transactions: [record] }
    })
  }

  /**
   * Remove a holder from the allowlist (e.g. KYC lapsed) without banning them.
   * Any balance stays in place but can no longer be sent to or from other holders.
   * The holder can be re-approved later with `authorizeHolder`.
   */
  revokeAuthorization(address: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      const token = await readMPToken(this.client, this.issuanceId, address)
      if (!token || (token.Flags & lsfMPToken.authorized) === 0) {
        return unchanged()
      }
      const record = await this.submitUnauthorize(address)
      await this.expectHolder(address, (s) => !s.authorized, 'holder is not authorized')
      return { changed: true, transactions: [record] }
    })
  }

  // ------------------------------------------------------------- issuance

  /** Send newly issued tokens to an approved, non-frozen, non-banned holder. */
  issue(address: string, amount: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      const units = toBaseUnits(amount, this.assetScale)
      await this.assertNotBanned(address)
      const [issuance, token] = await Promise.all([
        this.requireIssuance(),
        readMPToken(this.client, this.issuanceId, address),
      ])
      if ((issuance.Flags & lsfIssuance.locked) !== 0) {
        throw new ComplianceError('GLOBALLY_FROZEN', `${this.issuanceId} is globally frozen; refusing to issue`)
      }
      if (!token) {
        throw new ComplianceError('HOLDER_NOT_OPTED_IN', `${address} has not opted in to ${this.issuanceId}`)
      }
      if ((token.Flags & lsfMPToken.authorized) === 0) {
        throw new ComplianceError('HOLDER_NOT_AUTHORIZED', `${address} is not an approved holder`)
      }
      if ((token.Flags & lsfMPToken.locked) !== 0) {
        throw new ComplianceError('HOLDER_FROZEN', `${address} is frozen; refusing to issue`)
      }
      const { record } = await this.submit({
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
      })
      this.logger.info('tokens issued', { holder: address, amount, hash: record.hash })
      return { changed: true, transactions: [record] }
    })
  }

  // ------------------------------------------------------------- clawback

  /**
   * Claw back tokens from a holder. `amount` is in token units, or `'all'` for the
   * entire balance. A specific amount larger than the balance is refused rather than
   * silently clawing back less. Works regardless of freeze or authorization state.
   */
  clawback(address: string, amount: string | 'all'): Promise<ClawbackResult> {
    return this.exclusive(() => this.clawbackUnlocked(address, amount))
  }

  // --------------------------------------------------------------- freezes

  /** Lock one holder's balance: they can neither send nor receive (except redeeming to the issuer). */
  freezeHolder(address: string): Promise<ActionResult> {
    return this.exclusive(() => this.setHolderLock(address, true))
  }

  unfreezeHolder(address: string): Promise<ActionResult> {
    return this.exclusive(() => this.setHolderLock(address, false))
  }

  /** Lock every balance of this issuance. Individual freezes are preserved underneath. */
  freezeAll(): Promise<ActionResult> {
    return this.exclusive(() => this.setGlobalLock(true))
  }

  unfreezeAll(): Promise<ActionResult> {
    return this.exclusive(() => this.setGlobalLock(false))
  }

  // ------------------------------------------------------------------ bans

  /**
   * Permanently ban an address. Idempotent and safe to retry after a partial failure.
   *
   * 1. Record the ban (durably) so the address can never be approved or issued to again.
   * 2. Freeze the holder so their balance cannot move while we act.
   * 3. Revoke their authorization so they cannot receive the token again.
   * 4. Claw back their entire balance.
   * 5. Verify: zero balance and not authorized.
   */
  banHolder(address: string, reason: string): Promise<BanResult> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address)
      if (reason.trim() === '') {
        throw new InvalidInputError('a ban reason is required for the audit trail')
      }
      const transactions: TxRecord[] = []
      let changed = false

      if (!(await this.banRegistry.isBanned(this.issuanceId, address))) {
        await this.banRegistry.recordBan({
          issuanceId: this.issuanceId,
          address,
          reason,
          bannedAt: new Date().toISOString(),
        })
        changed = true
      }

      let token = await readMPToken(this.client, this.issuanceId, address)
      if (!token) {
        // Never opted in (or already deleted an empty entry): nothing on-ledger to undo.
        this.logger.info('holder banned (no ledger entry)', { holder: address })
        return { changed, transactions, clawedBack: '0' }
      }

      if ((token.Flags & lsfMPToken.locked) === 0) {
        const { record } = await this.submitLock(address, true)
        this.logger.info('holder frozen', { holder: address, hash: record.hash })
        transactions.push(record)
      }
      if ((token.Flags & lsfMPToken.authorized) !== 0) {
        transactions.push(await this.submitUnauthorize(address))
      }
      token = await readMPToken(this.client, this.issuanceId, address)
      let clawedBack = '0'
      if (token && parseLedgerAmount(token.MPTAmount) > 0n) {
        const result = await this.clawbackUnlocked(address, 'all')
        transactions.push(...result.transactions)
        clawedBack = result.clawedBack
      }

      const final = await this.getHolderState(address)
      if (final.balance !== '0' || final.authorized || !final.banned) {
        throw new ComplianceError(
          'POSTCONDITION_FAILED',
          `ban of ${address} did not complete: balance=${final.balance} authorized=${final.authorized} banned=${final.banned}`,
        )
      }
      this.logger.info('holder banned', { holder: address, clawedBack, hashes: transactions.map((t) => t.hash) })
      return { changed: changed || transactions.length > 0, transactions, clawedBack }
    })
  }

  // ------------------------------------------------------------- internals

  private async clawbackUnlocked(address: string, amount: string | 'all'): Promise<ClawbackResult> {
    this.assertHolderAddress(address)
    const requested = amount === 'all' ? undefined : toBaseUnits(amount, this.assetScale)
    const token = await readMPToken(this.client, this.issuanceId, address)
    const balance = parseLedgerAmount(token?.MPTAmount)
    if (balance === 0n) {
      throw new ComplianceError('NOTHING_TO_CLAW_BACK', `${address} holds none of ${this.issuanceId}`)
    }
    if (requested !== undefined && requested > balance) {
      throw new ComplianceError(
        'INSUFFICIENT_HOLDER_BALANCE',
        `cannot claw back ${amount} from ${address}; balance is ${fromBaseUnits(balance, this.assetScale)}`,
      )
    }
    // For 'all', request the protocol maximum: the ledger then claws back whatever the
    // balance is at execution time, so a concurrent inbound transfer cannot be left behind.
    const value = (requested ?? MAX_MPT_BASE_UNITS).toString()
    const { record, meta } = await this.submit({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value },
    })
    const clawed = outstandingDecrease(meta, this.issuanceId, this.issuerAddress)
    const clawedBack = fromBaseUnits(clawed, this.assetScale)
    this.logger.info('tokens clawed back', { holder: address, clawedBack, hash: record.hash })
    return { changed: true, transactions: [record], clawedBack }
  }

  private async setHolderLock(address: string, lock: boolean): Promise<ActionResult> {
    this.assertHolderAddress(address)
    const token = await readMPToken(this.client, this.issuanceId, address)
    if (!token) {
      throw new ComplianceError('HOLDER_NOT_OPTED_IN', `${address} has no balance entry for ${this.issuanceId} to (un)freeze`)
    }
    if (((token.Flags & lsfMPToken.locked) !== 0) === lock) {
      return unchanged()
    }
    const { record } = await this.submitLock(address, lock)
    await this.expectHolder(address, (s) => s.frozen === lock, lock ? 'holder is frozen' : 'holder is not frozen')
    this.logger.info(lock ? 'holder frozen' : 'holder unfrozen', { holder: address, hash: record.hash })
    return { changed: true, transactions: [record] }
  }

  private async setGlobalLock(lock: boolean): Promise<ActionResult> {
    const issuance = await this.requireIssuance()
    if (((issuance.Flags & lsfIssuance.locked) !== 0) === lock) {
      return unchanged()
    }
    const { record } = await this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    const after = await this.requireIssuance()
    if (((after.Flags & lsfIssuance.locked) !== 0) !== lock) {
      throw new ComplianceError('POSTCONDITION_FAILED', `global ${lock ? 'freeze' : 'unfreeze'} not reflected on-ledger`)
    }
    this.logger.info(lock ? 'issuance globally frozen' : 'issuance globally unfrozen', { hash: record.hash })
    return { changed: true, transactions: [record] }
  }

  private submitLock(address: string, lock: boolean): Promise<Submitted> {
    return this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
  }

  private async submitUnauthorize(address: string): Promise<TxRecord> {
    const { record } = await this.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    this.logger.info('holder authorization revoked', { holder: address, hash: record.hash })
    return record
  }

  private submit(tx: SubmittableTransaction): Promise<Submitted> {
    return submit(this.client, this.wallet, tx, this.logger)
  }

  private async requireIssuance(): Promise<RawIssuance> {
    const issuance = await readIssuance(this.client, this.issuanceId)
    if (!issuance) {
      throw new ComplianceError('ISSUANCE_NOT_FOUND', `MPT issuance ${this.issuanceId} no longer exists`)
    }
    return issuance
  }

  private async assertNotBanned(address: string): Promise<void> {
    if (await this.banRegistry.isBanned(this.issuanceId, address)) {
      throw new ComplianceError('HOLDER_BANNED', `${address} is banned from ${this.issuanceId}`)
    }
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) {
      throw new InvalidInputError(`not a valid classic address: ${JSON.stringify(address)}`)
    }
    if (address === this.issuerAddress) {
      throw new ComplianceError('ISSUER_IS_HOLDER', 'the issuer cannot be a holder of its own MPT')
    }
  }

  private async expectHolder(address: string, predicate: (s: HolderState) => boolean, description: string): Promise<void> {
    const state = await this.getHolderState(address)
    if (!predicate(state)) {
      throw new ComplianceError('POSTCONDITION_FAILED', `expected "${description}" for ${address}, got ${JSON.stringify(state)}`)
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn)
    this.mutex = run.catch(() => undefined)
    return run
  }
}

// ------------------------------------------------------------------ helpers

function unchanged(): ActionResult {
  return { changed: false, transactions: [] }
}

async function assertNetwork(options: MptIssuerOptions): Promise<void> {
  const { client, expectedNetworkId } = options
  if (!client.isConnected()) {
    throw new InvalidInputError('client must be connected')
  }
  let networkId = client.networkID
  if (networkId === undefined) {
    const info = await client.request({ command: 'server_info' })
    networkId = info.result.info.network_id
  }
  if (networkId !== expectedNetworkId) {
    throw new ComplianceError(
      'WRONG_NETWORK',
      `connected server reports network ID ${String(networkId)}, expected ${expectedNetworkId}`,
    )
  }
}

async function readLedgerEntry(client: Client, request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...request })
    return response.result.node as unknown as Record<string, unknown> | undefined
  } catch (err) {
    if (err instanceof RippledError && (err.data as { error?: string } | undefined)?.error === 'entryNotFound') {
      return undefined
    }
    throw err
  }
}

async function readIssuance(client: Client, issuanceId: string): Promise<RawIssuance | undefined> {
  const node = await readLedgerEntry(client, { mpt_issuance: issuanceId })
  if (!node) {
    return undefined
  }
  if (node.LedgerEntryType !== 'MPTokenIssuance' || typeof node.Issuer !== 'string' || typeof node.Flags !== 'number') {
    throw new Error(`unexpected ledger_entry response for MPT issuance ${issuanceId}`)
  }
  return node as unknown as RawIssuance
}

/** Note: `MPTAmount` is omitted from the entry when the balance is zero. */
async function readMPToken(client: Client, issuanceId: string, account: string): Promise<RawMPToken | undefined> {
  const node = await readLedgerEntry(client, { mptoken: { mpt_issuance_id: issuanceId, account } })
  if (!node) {
    return undefined
  }
  if (node.LedgerEntryType !== 'MPToken' || typeof node.Flags !== 'number') {
    throw new Error(`unexpected ledger_entry response for MPToken ${issuanceId}/${account}`)
  }
  return node as unknown as RawMPToken
}

/**
 * Sign locally (so the hash is known even if submission fails), submit, and wait
 * for validation. Anything other than a validated tesSUCCESS throws.
 */
async function submit(client: Client, wallet: Wallet, tx: SubmittableTransaction, logger: Logger): Promise<Submitted> {
  let hash: string | undefined
  try {
    const prepared = await client.autofill(tx)
    const signed = wallet.sign(prepared)
    hash = signed.hash
    const response = await client.submitAndWait(signed.tx_blob)
    const meta = response.result.meta
    const engineResult = typeof meta === 'object' ? meta.TransactionResult : undefined
    if (typeof meta !== 'object' || engineResult !== 'tesSUCCESS' || response.result.validated !== true) {
      throw new TransactionFailedError(
        `${tx.TransactionType} failed with ${engineResult ?? 'unknown result'}`,
        tx.TransactionType,
        engineResult,
        hash,
      )
    }
    const ledgerIndex = response.result.ledger_index
    if (ledgerIndex === undefined) {
      throw new TransactionFailedError(`${tx.TransactionType} validated without a ledger index`, tx.TransactionType, engineResult, hash)
    }
    return { record: { transactionType: tx.TransactionType, hash, ledgerIndex }, meta }
  } catch (err) {
    if (err instanceof TransactionFailedError) {
      logger.warn('transaction failed', { type: tx.TransactionType, result: err.engineResult, hash })
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    const engineResult = /\b(te[cflmr][A-Z_]+)\b/.exec(message)?.[1]
    logger.warn('transaction not confirmed', { type: tx.TransactionType, hash, error: message })
    throw new TransactionFailedError(
      `${tx.TransactionType} was not confirmed as successful: ${message}`,
      tx.TransactionType,
      engineResult,
      hash,
      { cause: err },
    )
  }
}

/** Decrease in the issuance's OutstandingAmount caused by a transaction (i.e. tokens clawed back or burned). */
function outstandingDecrease(meta: TransactionMetadata, issuanceId: string, issuer: string): bigint {
  for (const node of meta.AffectedNodes) {
    if (!('ModifiedNode' in node)) {
      continue
    }
    const modified = node.ModifiedNode
    if (modified.LedgerEntryType !== 'MPTokenIssuance') {
      continue
    }
    const final = modified.FinalFields as { Issuer?: string; Sequence?: number; OutstandingAmount?: string } | undefined
    const previous = modified.PreviousFields as { OutstandingAmount?: string } | undefined
    if (!final || !previous || !('OutstandingAmount' in previous)) {
      continue
    }
    if (final.Issuer !== issuer || !matchesSequence(final, issuanceId)) {
      continue
    }
    return parseLedgerAmount(previous.OutstandingAmount) - parseLedgerAmount(final.OutstandingAmount)
  }
  throw new Error(`transaction metadata does not show a change to ${issuanceId}'s outstanding amount`)
}

/** The MPTokenIssuanceID is the big-endian Sequence (4 bytes) followed by the issuer AccountID (20 bytes). */
function matchesSequence(fields: { Sequence?: number }, issuanceId: string): boolean {
  return fields.Sequence !== undefined && fields.Sequence.toString(16).padStart(8, '0').toUpperCase() === issuanceId.slice(0, 8)
}
