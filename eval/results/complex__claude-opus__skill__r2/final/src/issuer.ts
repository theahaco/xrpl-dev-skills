import {
  convertStringToHex,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  type Client,
  type Memo,
  type MPTokenIssuanceCreate,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type Wallet,
} from 'xrpl'
import { parseAmount, type MptAmountInput } from './amount'
import type { BanRecord, BanRegistry } from './banRegistry'
import { ComplianceError, MptIssuerError, ValidationError } from './errors'
import { submitAndConfirm, type SubmitOptions, type SubmitResult } from './submit'

/** MPTokenIssuance ledger-entry flags. */
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

/** MPToken ledger-entry flags. */
const lsfMPToken = { locked: 0x01, authorized: 0x02 } as const

/**
 * Capabilities that must never be enabled on the issuance. Balances held in
 * escrow or in confidential (encrypted) form are out of reach of an ordinary
 * Clawback, so enabling them would let a banned holder keep tokens; DEX trading
 * is left off so that every movement is a direct, auditable payment.
 */
const FORBIDDEN_CAPABILITIES = lsfIssuance.canEscrow | lsfIssuance.canTrade | lsfIssuance.canHoldConfidentialBalance

/** ImmutableFlags bits (DynamicMPT) that pin every capability to its creation value. */
const ALL_CAPABILITIES_IMMUTABLE = 0x02 | 0x04 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  outstandingAmount: bigint
  maximumAmount: bigint | undefined
  /** Global freeze in effect. */
  globallyFrozen: boolean
  capabilities: {
    canLock: boolean
    requireAuth: boolean
    canClawback: boolean
    canTransfer: boolean
    canEscrow: boolean
    canTrade: boolean
    canHoldConfidentialBalance: boolean
  }
  /** Ledger the state was read from. */
  ledgerIndex: number
}

export interface HolderState {
  address: string
  /** Holder has opted in (an MPToken entry exists). */
  optedIn: boolean
  /** Issuer has approved the holder (allowlist). */
  approved: boolean
  /** Individually frozen. */
  frozen: boolean
  balance: bigint
  ban: BanRecord | undefined
  ledgerIndex: number
}

export interface CreateIssuanceOptions {
  /** Decimal places for display. Amounts on-ledger are always integer base units. Default 0. */
  assetScale?: number
  /** Hard cap on outstanding supply, in base units. Default: protocol maximum. */
  maximumAmount?: MptAmountInput
  /** XLS-89 metadata (ticker, name, issuer_name, ...). Public and permanent. */
  metadata?: MPTokenMetadata
  /** Let approved holders pay each other (not only the issuer). Default true. */
  allowHolderTransfers?: boolean
}

export interface AuditEntry {
  operation: string
  issuanceId: string
  hash: string
  ledgerIndex: number
  holder?: string
  amount?: string
  reference?: string
}

export interface OperationOptions {
  /**
   * Optional case/ticket reference recorded in a transaction memo for audit
   * purposes. Memos are PUBLIC and permanent: never put personal data here.
   */
  reference?: string
}

export interface MptIssuerOptions {
  client: Client
  issuerWallet: Wallet
  issuanceId: string
  banRegistry: BanRegistry
  /** Called after every successful transaction; use it to write your audit log. */
  onAudit?: (entry: AuditEntry) => void
  submitOptions?: SubmitOptions
}

export interface RedemptionAssessment {
  txHash: string
  holder: string | undefined
  /** Base units delivered to the issuer. */
  amount: bigint | undefined
  /** Only pay out off-ledger when this is true. */
  payoutAllowed: boolean
  /** Why payout is refused (empty when allowed). */
  reasons: string[]
}

export interface BanResult {
  /** Hash of the authorization-revoking transaction, if one was needed. */
  revokeHash: string | undefined
  /** Clawback transactions and the amount each recovered. */
  clawbacks: { hash: string; amount: bigint }[]
  totalClawedBack: bigint
}

/**
 * Issuer-side compliance controls for a single MPT issuance.
 *
 * All ledger-changing operations of one instance are serialized, so that
 * account sequence numbers never collide and check-then-act compliance rules
 * (e.g. "never approve a banned address") cannot interleave with each other.
 * Run a single instance per issuer account; if several processes must share an
 * issuer, put a distributed lock around them and back the {@link BanRegistry}
 * with shared storage.
 */
export class MptIssuer {
  readonly issuanceId: string
  private readonly client: Client
  private readonly wallet: Wallet
  private readonly bans: BanRegistry
  private readonly onAudit: ((entry: AuditEntry) => void) | undefined
  private readonly submitOptions: SubmitOptions
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(options: MptIssuerOptions) {
    this.client = options.client
    this.wallet = options.issuerWallet
    this.issuanceId = options.issuanceId
    this.bans = options.banRegistry
    this.onAudit = options.onAudit
    this.submitOptions = options.submitOptions ?? {}
  }

  /**
   * Creates a new issuance with every compliance control enabled: allowlist
   * (RequireAuth), clawback, and per-holder / global freeze (CanLock).
   * Returns the new issuance ID.
   */
  static async createIssuance(
    client: Client,
    issuerWallet: Wallet,
    options: CreateIssuanceOptions = {},
    submitOptions: SubmitOptions = {},
  ): Promise<{ issuanceId: string; hash: string }> {
    const assetScale = options.assetScale ?? 0
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
      throw new ValidationError(`Invalid assetScale ${assetScale}`)
    }
    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuerWallet.classicAddress,
      AssetScale: assetScale,
      Flags:
        MPTokenIssuanceCreateFlags.tfMPTCanLock |
        MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanClawback |
        (options.allowHolderTransfers === false ? 0 : MPTokenIssuanceCreateFlags.tfMPTCanTransfer),
    }
    if (options.maximumAmount !== undefined) {
      tx.MaximumAmount = parseAmount(options.maximumAmount, 'maximumAmount').toString()
    }
    if (options.metadata !== undefined) tx.MPTokenMetadata = encodeMPTokenMetadata(options.metadata)
    // Where issuance flags are mutable (DynamicMPT), pin them so the controls
    // above can never be switched off, nor escrow/confidential balances on.
    if (await isAmendmentEnabled(client, 'DynamicMPT')) tx.ImmutableFlags = ALL_CAPABILITIES_IMMUTABLE

    const result = await submitAndConfirm(client, issuerWallet, tx, submitOptions)
    const issuanceId = (result.meta as { mpt_issuance_id?: string }).mpt_issuance_id
    if (!issuanceId) {
      throw new MptIssuerError(`MPTokenIssuanceCreate ${result.hash} succeeded but returned no mpt_issuance_id`)
    }
    return { issuanceId, hash: result.hash }
  }

  /**
   * Binds to an existing issuance, verifying that the wallet is its issuer and
   * that the issuance has every control this module relies on.
   */
  static async load(options: MptIssuerOptions): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(options.issuanceId)) {
      throw new ValidationError(`Invalid MPT issuance ID ${JSON.stringify(options.issuanceId)}`)
    }
    const issuer = new MptIssuer(options)
    const state = await issuer.getIssuance()
    if (state.issuer !== options.issuerWallet.classicAddress) {
      throw new ValidationError(
        `Issuance ${options.issuanceId} is issued by ${state.issuer}, not ${options.issuerWallet.classicAddress}`,
      )
    }
    const { canLock, requireAuth, canClawback, canEscrow, canTrade, canHoldConfidentialBalance } = state.capabilities
    if (!canLock || !requireAuth || !canClawback) {
      throw new ComplianceError(`Issuance ${options.issuanceId} lacks required controls (CanLock, RequireAuth, CanClawback)`)
    }
    if (canEscrow || canTrade || canHoldConfidentialBalance) {
      throw new ComplianceError(
        `Issuance ${options.issuanceId} allows escrow, trading or confidential balances, which clawback cannot fully reach`,
      )
    }
    return issuer
  }

  // ---------------------------------------------------------------- reads

  /** Reads the issuance from the latest validated ledger, or from `ledgerIndex` if given. */
  async getIssuance(ledgerIndex?: number): Promise<IssuanceState> {
    const response = await this.client.request({
      command: 'ledger_entry',
      mpt_issuance: this.issuanceId,
      ledger_index: ledgerIndex ?? 'validated',
    })
    const node = response.result.node as unknown as {
      Issuer: string
      Flags: number
      AssetScale?: number
      OutstandingAmount?: string
      MaximumAmount?: string
    }
    const flags = node.Flags
    return {
      issuanceId: this.issuanceId,
      issuer: node.Issuer,
      assetScale: node.AssetScale ?? 0,
      outstandingAmount: BigInt(node.OutstandingAmount ?? '0'),
      maximumAmount: node.MaximumAmount === undefined ? undefined : BigInt(node.MaximumAmount),
      globallyFrozen: (flags & lsfIssuance.locked) !== 0,
      capabilities: {
        canLock: (flags & lsfIssuance.canLock) !== 0,
        requireAuth: (flags & lsfIssuance.requireAuth) !== 0,
        canClawback: (flags & lsfIssuance.canClawback) !== 0,
        canTransfer: (flags & lsfIssuance.canTransfer) !== 0,
        canEscrow: (flags & lsfIssuance.canEscrow) !== 0,
        canTrade: (flags & lsfIssuance.canTrade) !== 0,
        canHoldConfidentialBalance: (flags & lsfIssuance.canHoldConfidentialBalance) !== 0,
      },
      ledgerIndex: (response.result as { ledger_index?: number }).ledger_index ?? 0,
    }
  }

  /** Reads a holder from the latest validated ledger, or from `ledgerIndex` if given. */
  async getHolder(address: string, ledgerIndex?: number): Promise<HolderState> {
    this.assertHolderAddress(address)
    const ban = await this.bans.get(address)
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.issuanceId, account: address },
        ledger_index: ledgerIndex ?? 'validated',
      })
      const node = response.result.node as unknown as { Flags: number; MPTAmount?: string }
      return {
        address,
        optedIn: true,
        approved: (node.Flags & lsfMPToken.authorized) !== 0,
        frozen: (node.Flags & lsfMPToken.locked) !== 0,
        balance: BigInt(node.MPTAmount ?? '0'),
        ban,
        ledgerIndex: (response.result as { ledger_index?: number }).ledger_index ?? 0,
      }
    } catch (error) {
      if ((error as { data?: { error?: string } }).data?.error !== 'entryNotFound') throw error
      return { address, optedIn: false, approved: false, frozen: false, balance: 0n, ban, ledgerIndex: ledgerIndex ?? 0 }
    }
  }

  // ---------------------------------------------------------------- redemptions

  /**
   * Decides whether an incoming token payment to the issuer (a redemption) may
   * be paid out off-ledger.
   *
   * The XRPL lock (freeze) only blocks transfers BETWEEN holders: a frozen
   * holder, or any holder during a global freeze, can still send the token to
   * the issuer. Those tokens are destroyed on arrival, but the value must not
   * leave the system, so the redemption backend MUST call this before paying
   * out. It reads the holder's state as of the ledger that included the
   * payment, and refuses payout for frozen, globally frozen or banned holders.
   */
  async assessRedemption(txHash: string): Promise<RedemptionAssessment> {
    const response = await this.client.request({ command: 'tx', transaction: txHash })
    const result = response.result as unknown as {
      validated?: boolean
      ledger_index?: number
      meta?: { TransactionResult?: string; delivered_amount?: unknown }
      tx_json?: { TransactionType?: string; Account?: string; Destination?: string }
    }
    const tx = result.tx_json ?? {}
    const delivered = result.meta?.delivered_amount as { mpt_issuance_id?: string; value?: string } | undefined
    const reject = (reason: string, holder?: string, amount?: bigint): RedemptionAssessment => ({
      txHash,
      holder,
      amount,
      payoutAllowed: false,
      reasons: [reason],
    })

    if (result.validated !== true || result.ledger_index === undefined) return reject('transaction is not validated')
    if (result.meta?.TransactionResult !== 'tesSUCCESS') return reject(`transaction result is ${result.meta?.TransactionResult}`)
    if (tx.TransactionType !== 'Payment' || tx.Destination !== this.address) return reject('not a payment to the issuer')
    if (delivered?.mpt_issuance_id?.toUpperCase() !== this.issuanceId.toUpperCase() || delivered.value === undefined) {
      return reject(`did not deliver ${this.issuanceId}`)
    }
    const holderAddress = tx.Account ?? ''
    const amount = BigInt(delivered.value)

    // A freeze or unfreeze may share the payment's ledger, so check the state
    // both before and after that ledger and refuse if either was frozen.
    const reasons = new Set<string>()
    for (const ledger of [result.ledger_index - 1, result.ledger_index]) {
      const [holder, issuance] = await Promise.all([this.getHolder(holderAddress, ledger), this.getIssuance(ledger)])
      if (holder.ban) reasons.add(`holder is banned (${holder.ban.reason})`)
      if (holder.frozen) reasons.add(`holder was frozen around ledger ${result.ledger_index}`)
      if (issuance.globallyFrozen) reasons.add(`token was globally frozen around ledger ${result.ledger_index}`)
      if (!holder.approved) reasons.add('holder was not approved')
    }
    return { txHash, holder: holderAddress, amount, payoutAllowed: reasons.size === 0, reasons: [...reasons] }
  }

  // ---------------------------------------------------------------- allowlist

  /**
   * Adds a holder to the allowlist after KYC. The holder must first opt in by
   * submitting their own MPTokenAuthorize. Banned addresses are refused.
   */
  approveHolder(address: string, options: OperationOptions = {}): Promise<SubmitResult | undefined> {
    return this.exclusive(async () => {
      const holder = await this.getHolder(address)
      if (holder.ban) {
        throw new ComplianceError(`${address} is banned (${holder.ban.reason}) and cannot be approved`)
      }
      if (!holder.optedIn) {
        throw new ComplianceError(`${address} has not opted in to ${this.issuanceId}; the holder must submit MPTokenAuthorize first`)
      }
      if (holder.approved) return undefined
      return this.submit('approveHolder', { TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: this.issuanceId, Holder: address }, { holder: address, ...options })
    })
  }

  /** Removes a holder from the allowlist: they can no longer send or receive the token. Their balance stays in place. */
  revokeApproval(address: string, options: OperationOptions = {}): Promise<SubmitResult | undefined> {
    return this.exclusive(() => this.revokeApprovalUnlocked(address, options))
  }

  // ---------------------------------------------------------------- movements

  /** Sends newly issued tokens to an approved holder. */
  issue(to: string, amount: MptAmountInput, options: OperationOptions = {}): Promise<SubmitResult> {
    const value = parseAmount(amount)
    return this.exclusive(async () => {
      const holder = await this.getHolder(to)
      if (holder.ban) throw new ComplianceError(`${to} is banned and cannot receive the token`)
      if (!holder.approved) throw new ComplianceError(`${to} is not an approved holder`)
      if (holder.frozen) throw new ComplianceError(`${to} is frozen`)
      if ((await this.getIssuance()).globallyFrozen) throw new ComplianceError(`${this.issuanceId} is globally frozen`)
      return this.submit(
        'issue',
        {
          TransactionType: 'Payment',
          Account: this.address,
          Destination: to,
          Amount: { mpt_issuance_id: this.issuanceId, value: value.toString() },
        },
        { holder: to, amount: value, ...options },
      )
    })
  }

  /** Claws back `amount` base units from a holder. Refuses to claw back more than the holder has. */
  clawback(holder: string, amount: MptAmountInput, options: OperationOptions = {}): Promise<SubmitResult> {
    const value = parseAmount(amount)
    return this.exclusive(async () => {
      const state = await this.getHolder(holder)
      if (state.balance < value) {
        throw new ComplianceError(`Cannot claw back ${value} from ${holder}: balance is ${state.balance}`)
      }
      return this.clawbackUnlocked(holder, value, options)
    })
  }

  // ---------------------------------------------------------------- freezes

  /** Freezes one holder: they can neither send nor receive the token. */
  freezeHolder(address: string, options: OperationOptions = {}): Promise<SubmitResult> {
    return this.setHolderLock(address, true, options)
  }

  unfreezeHolder(address: string, options: OperationOptions = {}): Promise<SubmitResult> {
    return this.setHolderLock(address, false, options)
  }

  /** Freezes all movement of the token between holders (incident response). */
  freezeAll(options: OperationOptions = {}): Promise<SubmitResult> {
    return this.exclusive(() =>
      this.submit(
        'freezeAll',
        { TransactionType: 'MPTokenIssuanceSet', Account: this.address, MPTokenIssuanceID: this.issuanceId, Flags: MPTokenIssuanceSetFlags.tfMPTLock },
        options,
      ),
    )
  }

  unfreezeAll(options: OperationOptions = {}): Promise<SubmitResult> {
    return this.exclusive(() =>
      this.submit(
        'unfreezeAll',
        { TransactionType: 'MPTokenIssuanceSet', Account: this.address, MPTokenIssuanceID: this.issuanceId, Flags: MPTokenIssuanceSetFlags.tfMPTUnlock },
        options,
      ),
    )
  }

  // ---------------------------------------------------------------- bans

  /**
   * Bans an address: records the ban, revokes its approval (so it can no longer
   * send or receive), then claws back its entire balance.
   *
   * The ban is recorded durably before anything is submitted, so even if a
   * later step fails the address can never be re-approved. The method is
   * idempotent: call it again to finish an interrupted ban. It resolves only
   * once the ledger shows the address unapproved with a zero balance.
   */
  ban(address: string, reason: string, options: OperationOptions = {}): Promise<BanResult> {
    this.assertHolderAddress(address)
    if (!reason.trim()) throw new ValidationError('A ban reason is required')
    return this.exclusive(async () => {
      await this.bans.add({ address, reason, bannedAt: new Date().toISOString() })

      // Revoke first: once unapproved the holder can neither receive nor send,
      // so the balance we then claw back cannot change underneath us.
      const revoke = await this.revokeApprovalUnlocked(address, options)
      const result: BanResult = { revokeHash: revoke?.hash, clawbacks: [], totalClawedBack: 0n }

      for (let attempt = 0; ; attempt++) {
        const state = await this.getHolder(address)
        if (state.balance === 0n) {
          if (state.approved) throw new MptIssuerError(`Ban of ${address} incomplete: holder is still approved`)
          return result
        }
        if (attempt === 3) {
          throw new MptIssuerError(`Ban of ${address} incomplete: balance still ${state.balance} after ${attempt} clawbacks`)
        }
        const clawback = await this.clawbackUnlocked(address, state.balance, options)
        result.clawbacks.push({ hash: clawback.hash, amount: state.balance })
        result.totalClawedBack += state.balance
      }
    })
  }

  isBanned(address: string): Promise<boolean> {
    return this.bans.get(address).then((record) => record !== undefined)
  }

  // ---------------------------------------------------------------- internals

  private get address(): string {
    return this.wallet.classicAddress
  }

  private setHolderLock(address: string, lock: boolean, options: OperationOptions): Promise<SubmitResult> {
    this.assertHolderAddress(address)
    return this.exclusive(async () => {
      const holder = await this.getHolder(address)
      if (!holder.optedIn) throw new ComplianceError(`${address} does not hold ${this.issuanceId}`)
      return this.submit(
        lock ? 'freezeHolder' : 'unfreezeHolder',
        {
          TransactionType: 'MPTokenIssuanceSet',
          Account: this.address,
          MPTokenIssuanceID: this.issuanceId,
          Holder: address,
          Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
        },
        { holder: address, ...options },
      )
    })
  }

  private async revokeApprovalUnlocked(address: string, options: OperationOptions): Promise<SubmitResult | undefined> {
    const holder = await this.getHolder(address)
    if (!holder.approved) return undefined
    return this.submit(
      'revokeApproval',
      {
        TransactionType: 'MPTokenAuthorize',
        Account: this.address,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
        Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
      },
      { holder: address, ...options },
    )
  }

  private clawbackUnlocked(holder: string, amount: bigint, options: OperationOptions): Promise<SubmitResult> {
    return this.submit(
      'clawback',
      {
        TransactionType: 'Clawback',
        Account: this.address,
        Holder: holder,
        Amount: { mpt_issuance_id: this.issuanceId, value: amount.toString() },
      },
      { holder, amount, ...options },
    )
  }

  private async submit(
    operation: string,
    tx: SubmittableTransaction,
    details: { holder?: string; amount?: bigint; reference?: string },
  ): Promise<SubmitResult> {
    const memo: Memo = { Memo: { MemoType: convertStringToHex(`mpt-issuer/${operation}`) } }
    if (details.reference) memo.Memo.MemoData = convertStringToHex(details.reference)
    const result = await submitAndConfirm(this.client, this.wallet, { ...tx, Memos: [memo] }, this.submitOptions)
    const entry: AuditEntry = { operation, issuanceId: this.issuanceId, hash: result.hash, ledgerIndex: result.ledgerIndex }
    if (details.holder !== undefined) entry.holder = details.holder
    if (details.amount !== undefined) entry.amount = details.amount.toString()
    if (details.reference !== undefined) entry.reference = details.reference
    this.onAudit?.(entry)
    return result
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) throw new ValidationError(`Invalid classic address ${JSON.stringify(address)}`)
    if (address === this.address) throw new ValidationError('The issuer cannot be a holder of its own token')
  }
}

async function isAmendmentEnabled(client: Client, name: string): Promise<boolean> {
  const response = await client.request({ command: 'feature' })
  return Object.values(response.result.features).some((f) => f.name === name && f.enabled)
}
