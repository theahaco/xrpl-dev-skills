import {
  Client,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  RippledError,
  type Clawback,
  type LedgerEntry,
  type MPTokenAuthorize,
  type MPTokenIssuanceSet,
  type MPTokenMetadata,
  type Payment,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl'

import { assertAssetScale, fromBaseUnits, toBaseUnits } from './amount.js'
import type { BanRecord, BanStore } from './banStore.js'
import { submitAndConfirm, type SubmitOptions, type TxOutcome } from './submit.js'

/** Ledger flags on an MPTokenIssuance entry. */
export const ISSUANCE_FLAGS = {
  locked: 0x01,
  canLock: 0x02,
  requireAuth: 0x04,
  canEscrow: 0x08,
  canTrade: 0x10,
  canTransfer: 0x20,
  canClawback: 0x40,
  canHoldConfidentialBalance: 0x80,
} as const

/** Ledger flags on a holder's MPToken entry. */
export const MPTOKEN_FLAGS = {
  locked: 0x01,
  authorized: 0x02,
} as const

/**
 * Capabilities every issuance managed by this module must have.
 * - canLock:      per-holder and global freeze
 * - requireAuth:  allowlist (only issuer-approved holders may hold the token)
 * - canClawback:  clawback, and the "zero balance" half of a ban
 * - canTransfer:  holder-to-holder payments (without it the token can only move to/from the issuer)
 */
const REQUIRED_FLAGS = ISSUANCE_FLAGS.canLock | ISSUANCE_FLAGS.requireAuth | ISSUANCE_FLAGS.canClawback | ISSUANCE_FLAGS.canTransfer

/**
 * Capabilities that must be OFF. Escrowed, DEX-offered or confidential balances
 * sit outside the plain holder balance that clawback, freeze and ban act on, so
 * enabling them would open ways around the compliance controls.
 */
const FORBIDDEN_FLAGS = ISSUANCE_FLAGS.canEscrow | ISSUANCE_FLAGS.canTrade | ISSUANCE_FLAGS.canHoldConfidentialBalance

/** A compliance rule enforced by this module refused the operation. Nothing was submitted. */
export class ComplianceError extends Error {
  override readonly name = 'ComplianceError'
}

export interface AuditEvent {
  action: string
  issuanceId: string
  holder?: string
  amount?: string
  txHash?: string
  detail?: string
}

export interface AuditLogger {
  record(event: AuditEvent): void
}

/** Writes one JSON line per event to stdout. Replace with your audit sink in production. */
export const consoleAuditLogger: AuditLogger = {
  record(event) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }))
  },
}

export interface HolderState {
  address: string
  /** Whether the holder has opted in (an MPToken ledger entry exists). */
  optedIn: boolean
  authorized: boolean
  locked: boolean
  /** Balance in human units. */
  balance: string
  balanceUnits: bigint
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  flags: number
  globallyLocked: boolean
  outstanding: string
  maximumAmount?: string
}

export interface CreateIssuanceParams {
  /** Decimal places for amounts. Immutable after creation. */
  assetScale: number
  /** Optional hard supply cap in human units. */
  maximumAmount?: string
  /** XLS-89 metadata (ticker, name, issuer_name, ...). */
  metadata: MPTokenMetadata
}

export interface MptIssuerOptions {
  client: Client
  wallet: Wallet
  issuanceId: string
  banStore: BanStore
  audit?: AuditLogger
  submit?: SubmitOptions
}

/**
 * Issuer-side controls for a regulated MPT.
 *
 * All issuer transactions from one instance are serialized so account
 * sequence numbers never collide. Run one instance per issuer account.
 */
export class MptIssuer {
  readonly issuanceId: string
  private readonly client: Client
  private readonly wallet: Wallet
  private readonly banStore: BanStore
  private readonly audit: AuditLogger
  private readonly submitOptions: SubmitOptions
  private assetScale = 0
  private txQueue: Promise<unknown> = Promise.resolve()

  private get account(): string {
    return this.wallet.classicAddress
  }

  private constructor(options: MptIssuerOptions) {
    this.client = options.client
    this.wallet = options.wallet
    this.issuanceId = options.issuanceId
    this.banStore = options.banStore
    this.audit = options.audit ?? consoleAuditLogger
    this.submitOptions = options.submit ?? {}
  }

  /**
   * Create a new issuance with the compliance capabilities enabled and every
   * other capability disabled. These flags cannot be changed afterwards.
   */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    params: CreateIssuanceParams,
    options: SubmitOptions = {},
  ): Promise<{ issuanceId: string; txHash: string }> {
    assertAssetScale(params.assetScale)
    const outcome = await submitAndConfirm(
      client,
      wallet,
      {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: wallet.classicAddress,
        AssetScale: params.assetScale,
        TransferFee: 0,
        Flags:
          MPTokenIssuanceCreateFlags.tfMPTCanLock |
          MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
          MPTokenIssuanceCreateFlags.tfMPTCanTransfer |
          MPTokenIssuanceCreateFlags.tfMPTCanClawback,
        MPTokenMetadata: encodeMPTokenMetadata(params.metadata),
        ...(params.maximumAmount === undefined
          ? {}
          : { MaximumAmount: toBaseUnits(params.maximumAmount, params.assetScale).toString() }),
      },
      options,
    )
    const issuanceId = (outcome.meta as { mpt_issuance_id?: string }).mpt_issuance_id
    if (issuanceId === undefined) {
      throw new Error(`MPTokenIssuanceCreate ${outcome.hash} succeeded but metadata has no mpt_issuance_id`)
    }
    return { issuanceId, txHash: outcome.hash }
  }

  /**
   * Attach to an existing issuance. Verifies that it belongs to `wallet` and
   * has exactly the capability profile this module relies on.
   */
  static async load(options: MptIssuerOptions): Promise<MptIssuer> {
    const issuer = new MptIssuer(options)
    const issuance = await issuer.fetchIssuance()
    if (issuance.Issuer !== options.wallet.classicAddress) {
      throw new Error(`Issuance ${options.issuanceId} is issued by ${issuance.Issuer}, not ${options.wallet.classicAddress}`)
    }
    if ((issuance.Flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS) {
      throw new Error(`Issuance ${options.issuanceId} lacks required compliance capabilities (flags 0x${issuance.Flags.toString(16)})`)
    }
    if ((issuance.Flags & FORBIDDEN_FLAGS) !== 0) {
      throw new Error(`Issuance ${options.issuanceId} enables escrow/trade/confidential balances, which bypass compliance controls`)
    }
    issuer.assetScale = issuance.AssetScale ?? 0
    return issuer
  }

  // ---------------------------------------------------------------- reads

  async getIssuance(): Promise<IssuanceState> {
    const issuance = await this.fetchIssuance()
    return {
      issuanceId: this.issuanceId,
      issuer: issuance.Issuer,
      assetScale: this.assetScale,
      flags: issuance.Flags,
      globallyLocked: (issuance.Flags & ISSUANCE_FLAGS.locked) !== 0,
      outstanding: fromBaseUnits(BigInt(issuance.OutstandingAmount), this.assetScale),
      ...(issuance.MaximumAmount === undefined
        ? {}
        : { maximumAmount: fromBaseUnits(BigInt(issuance.MaximumAmount), this.assetScale) }),
    }
  }

  async getHolder(holder: string): Promise<HolderState> {
    this.assertHolderAddress(holder)
    const token = await this.fetchMPToken(holder)
    const units = BigInt(token?.MPTAmount ?? '0')
    return {
      address: holder,
      optedIn: token !== undefined,
      authorized: token !== undefined && (token.Flags & MPTOKEN_FLAGS.authorized) !== 0,
      locked: token !== undefined && (token.Flags & MPTOKEN_FLAGS.locked) !== 0,
      balance: fromBaseUnits(units, this.assetScale),
      balanceUnits: units,
    }
  }

  async getBan(holder: string): Promise<BanRecord | undefined> {
    return this.banStore.get(holder)
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Add a KYC-approved holder to the allowlist. The holder must have opted in
   * first (MPTokenAuthorize from their own account). Banned addresses are refused.
   */
  async approveHolder(holder: string): Promise<TxOutcome | undefined> {
    this.assertHolderAddress(holder)
    await this.assertNotBanned(holder, 'approve')
    const state = await this.getHolder(holder)
    if (!state.optedIn) {
      throw new ComplianceError(`${holder} has not opted in to ${this.issuanceId}; they must submit MPTokenAuthorize first`)
    }
    if (state.authorized) return undefined
    return this.run(
      'approve',
      holder,
      undefined,
      {
        TransactionType: 'MPTokenAuthorize',
        Account: this.account,
        MPTokenIssuanceID: this.issuanceId,
        Holder: holder,
      },
      // Re-checked inside the queue so a concurrent ban() cannot be overtaken.
      async () => this.assertNotBanned(holder, 'approve'),
    )
  }

  /**
   * Remove a holder from the allowlist. They keep any balance but can no
   * longer receive the token or transfer it to other holders.
   */
  async revokeApproval(holder: string): Promise<TxOutcome | undefined> {
    this.assertHolderAddress(holder)
    const state = await this.getHolder(holder)
    if (!state.authorized) return undefined
    return this.run('revoke-approval', holder, undefined, {
      TransactionType: 'MPTokenAuthorize',
      Account: this.account,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
  }

  // ------------------------------------------------------------- issuing

  /**
   * Issue (mint) `amount` to an approved holder.
   *
   * The ledger does NOT apply per-holder or global locks to payments sent by
   * the issuer itself, so this method enforces them: it refuses to issue to a
   * frozen holder or while the token is globally frozen.
   */
  async issue(holder: string, amount: string): Promise<TxOutcome> {
    this.assertHolderAddress(holder)
    const units = toBaseUnits(amount, this.assetScale)
    const precheck = async (): Promise<void> => {
      await this.assertNotBanned(holder, 'issue to')
      if ((await this.getIssuance()).globallyLocked) {
        throw new ComplianceError('Refusing to issue: the token is globally frozen')
      }
      const state = await this.getHolder(holder)
      if (!state.authorized) throw new ComplianceError(`Refusing to issue to ${holder}: holder is not approved`)
      if (state.locked) throw new ComplianceError(`Refusing to issue to ${holder}: holder is frozen`)
    }
    return this.run(
      'issue',
      holder,
      amount,
      {
        TransactionType: 'Payment',
        Account: this.account,
        Destination: holder,
        Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
      },
      precheck,
    )
  }

  // ------------------------------------------------------------ clawback

  /**
   * Claw back exactly `amount` from a holder. Fails without submitting if the
   * holder's balance is lower, rather than silently clawing back less.
   */
  async clawback(holder: string, amount: string): Promise<TxOutcome> {
    this.assertHolderAddress(holder)
    const units = toBaseUnits(amount, this.assetScale)
    const state = await this.getHolder(holder)
    if (state.balanceUnits < units) {
      throw new ComplianceError(`Cannot claw back ${amount} from ${holder}: balance is ${state.balance}`)
    }
    const outcome = await this.clawbackUnits(holder, units, 'clawback')
    const clawed = clawedBackUnits(outcome.meta, holder, this.issuanceId)
    if (clawed !== units) {
      // Only possible if the balance moved between the check and validation.
      throw new Error(
        `Clawback ${outcome.hash} removed ${fromBaseUnits(clawed, this.assetScale)} instead of ${amount}; investigate`,
      )
    }
    return outcome
  }

  /** Claw back a holder's entire balance. Returns undefined if it was already zero. */
  async clawbackAll(holder: string): Promise<TxOutcome | undefined> {
    this.assertHolderAddress(holder)
    const state = await this.getHolder(holder)
    if (state.balanceUnits === 0n) return undefined
    return this.clawbackUnits(holder, state.balanceUnits, 'clawback-all')
  }

  // -------------------------------------------------------------- freeze

  /**
   * Freeze one holder. The ledger then rejects transfers to or from them
   * (tecLOCKED), and issue() refuses to pay them. Note that the ledger still
   * lets a frozen holder return tokens to the issuer, as with trust-line freezes.
   */
  async freezeHolder(holder: string): Promise<TxOutcome | undefined> {
    this.assertHolderAddress(holder)
    const state = await this.getHolder(holder)
    if (!state.optedIn) throw new ComplianceError(`${holder} holds no MPToken for ${this.issuanceId}; nothing to freeze`)
    if (state.locked) return undefined
    return this.setLock('freeze-holder', holder, true)
  }

  /** Lift a per-holder freeze. Refused for banned holders, whose freeze is part of the ban. */
  async unfreezeHolder(holder: string): Promise<TxOutcome | undefined> {
    this.assertHolderAddress(holder)
    await this.assertNotBanned(holder, 'unfreeze')
    const state = await this.getHolder(holder)
    if (!state.locked) return undefined
    return this.setLock('unfreeze-holder', holder, false, async () => this.assertNotBanned(holder, 'unfreeze'))
  }

  /**
   * Freeze all movement of the token between holders, and stop issue() from
   * minting. Clawback and bans keep working during a global freeze.
   */
  async freezeAll(): Promise<TxOutcome | undefined> {
    if ((await this.getIssuance()).globallyLocked) return undefined
    return this.setLock('freeze-all', undefined, true)
  }

  /** Lift the global freeze. Per-holder freezes stay in place. */
  async unfreezeAll(): Promise<TxOutcome | undefined> {
    if (!(await this.getIssuance()).globallyLocked) return undefined
    return this.setLock('unfreeze-all', undefined, false)
  }

  // ----------------------------------------------------------------- ban

  /**
   * Ban an address: it ends up holding none of the token and can never
   * receive it again.
   *
   * 1. Record the ban durably first, so approvals and issuance are refused
   *    even if a later step fails (fail closed).
   * 2. Freeze the holder, so other holders cannot pay them while we empty
   *    the account (issue() already refuses because of step 1).
   * 3. Claw back the entire balance.
   * 4. Remove their authorization. Under RequireAuth nobody can then pay them,
   *    and since approveHolder refuses banned addresses, this holds even if
   *    they delete their MPToken and opt in again.
   * 5. Verify the resulting ledger state.
   *
   * Idempotent: calling it again resumes an interrupted ban.
   */
  async ban(holder: string, reason: string): Promise<HolderState> {
    this.assertHolderAddress(holder)
    if (reason.trim() === '') throw new ComplianceError('A ban reason is required')

    const existing = await this.banStore.get(holder)
    const record: BanRecord = existing ?? { address: holder, reason, bannedAt: new Date().toISOString() }
    if (existing === undefined) {
      await this.banStore.put(record)
      this.audit.record({ action: 'ban-recorded', issuanceId: this.issuanceId, holder, detail: reason })
    }

    let state = await this.getHolder(holder)
    if (state.optedIn) {
      if (!state.locked) await this.setLock('ban:freeze-holder', holder, true)
      // Frozen, so the balance cannot grow; loop only as a defensive re-check.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        state = await this.getHolder(holder)
        if (state.balanceUnits === 0n) break
        await this.clawbackUnits(holder, state.balanceUnits, 'ban:clawback-all')
      }
      state = await this.getHolder(holder)
      if (state.authorized) {
        await this.run('ban:revoke-approval', holder, undefined, {
          TransactionType: 'MPTokenAuthorize',
          Account: this.account,
          MPTokenIssuanceID: this.issuanceId,
          Holder: holder,
          Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
        })
      }
      state = await this.getHolder(holder)
    }

    if (state.balanceUnits !== 0n || state.authorized || (state.optedIn && !state.locked)) {
      throw new Error(`Ban of ${holder} could not be verified on-ledger: ${JSON.stringify(serializable(state))}`)
    }
    await this.banStore.put({ ...record, enforcedAt: new Date().toISOString() })
    this.audit.record({ action: 'ban-enforced', issuanceId: this.issuanceId, holder })
    return state
  }

  // ------------------------------------------------------------ internals

  private async clawbackUnits(holder: string, units: bigint, action: string): Promise<TxOutcome> {
    return this.run(action, holder, fromBaseUnits(units, this.assetScale), {
      TransactionType: 'Clawback',
      Account: this.account,
      Holder: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
    })
  }

  private async setLock(
    action: string,
    holder: string | undefined,
    lock: boolean,
    precheck?: () => Promise<void>,
  ): Promise<TxOutcome> {
    return this.run(
      action,
      holder,
      undefined,
      {
        TransactionType: 'MPTokenIssuanceSet',
        Account: this.account,
        MPTokenIssuanceID: this.issuanceId,
        Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
        ...(holder === undefined ? {} : { Holder: holder }),
      },
      precheck,
    )
  }

  /**
   * Submit an issuer transaction and write an audit record for the outcome.
   * Transactions are serialized per instance; `precheck` runs inside that
   * serialized section, so it sees the effects of every earlier issuer action.
   */
  private async run(
    action: string,
    holder: string | undefined,
    amount: string | undefined,
    tx: IssuerTx,
    precheck?: () => Promise<void>,
  ): Promise<TxOutcome> {
    const execute = async (): Promise<TxOutcome> => {
      const base = {
        action,
        issuanceId: this.issuanceId,
        ...(holder === undefined ? {} : { holder }),
        ...(amount === undefined ? {} : { amount }),
      }
      if (precheck !== undefined) {
        try {
          await precheck()
        } catch (error) {
          this.audit.record({ ...base, detail: `REFUSED: ${(error as Error).message}` })
          throw error
        }
      }
      try {
        const outcome = await submitAndConfirm(
          this.client,
          this.wallet,
          tx,
          this.submitOptions,
        )
        this.audit.record({ ...base, txHash: outcome.hash, detail: outcome.result })
        return outcome
      } catch (error) {
        this.audit.record({ ...base, detail: `FAILED: ${(error as Error).message}` })
        throw error
      }
    }
    const result = this.txQueue.then(execute, execute)
    this.txQueue = result.catch(() => undefined)
    return result
  }

  private async assertNotBanned(holder: string, verb: string): Promise<void> {
    if ((await this.banStore.get(holder)) !== undefined) {
      throw new ComplianceError(`Refusing to ${verb} ${holder}: address is banned`)
    }
  }

  private assertHolderAddress(holder: string): void {
    if (!isValidClassicAddress(holder)) throw new ComplianceError(`Invalid classic address: ${holder}`)
    if (holder === this.wallet.classicAddress) throw new ComplianceError('The issuer cannot be a holder of its own token')
  }

  private async fetchIssuance(): Promise<LedgerEntry.MPTokenIssuance> {
    const response = await this.client.request({
      command: 'ledger_entry',
      mpt_issuance: this.issuanceId,
      ledger_index: 'validated',
    })
    return response.result.node as unknown as LedgerEntry.MPTokenIssuance
  }

  private async fetchMPToken(holder: string): Promise<LedgerEntry.MPToken | undefined> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.issuanceId, account: holder },
        ledger_index: 'validated',
      })
      return response.result.node as unknown as LedgerEntry.MPToken
    } catch (error) {
      if (error instanceof RippledError && (error.data as { error?: unknown } | undefined)?.error === 'entryNotFound') {
        return undefined
      }
      throw error
    }
  }
}

type IssuerTx = Payment | Clawback | MPTokenAuthorize | MPTokenIssuanceSet

/** Amount removed from `holder`'s MPToken by a validated clawback, read from metadata. */
function clawedBackUnits(meta: TransactionMetadata, holder: string, issuanceId: string): bigint {
  for (const node of meta.AffectedNodes) {
    if (!('ModifiedNode' in node) || node.ModifiedNode.LedgerEntryType !== 'MPToken') continue
    const final = node.ModifiedNode.FinalFields as { Account?: string; MPTokenIssuanceID?: string; MPTAmount?: string }
    if (final.Account !== holder || final.MPTokenIssuanceID !== issuanceId) continue
    const previous = (node.ModifiedNode.PreviousFields ?? {}) as { MPTAmount?: string }
    // An absent MPTAmount means zero; absent from PreviousFields means unchanged.
    const after = BigInt(final.MPTAmount ?? '0')
    const before = 'MPTAmount' in previous ? BigInt(previous.MPTAmount ?? '0') : after
    return before - after
  }
  return 0n
}

function serializable(state: HolderState): Omit<HolderState, 'balanceUnits'> {
  const { balanceUnits: _units, ...rest } = state
  return rest
}
