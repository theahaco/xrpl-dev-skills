import {
  RippledError,
  encodeMPTokenMetadata,
  LedgerEntry,
  type Client,
  type Clawback,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceCreateFlagsInterface,
  type MPTokenIssuanceSet,
  type MPTokenMetadata,
  type Payment,
  type Wallet,
} from 'xrpl'
import { submitAndCheck } from './submit'

type MPToken = LedgerEntry.MPToken
type MPTokenIssuance = LedgerEntry.MPTokenIssuance
const { MPTokenIssuanceFlags } = LedgerEntry

// The MPToken ledger object's own flags aren't exposed as an enum by the xrpl
// package (only the parent MPTokenIssuance's flags are). Values are from the
// MPToken ledger entry reference: lsfMPTLocked = 0x01, lsfMPTAuthorized = 0x02.
const MPTOKEN_LSF_LOCKED = 0x00000001
const MPTOKEN_LSF_AUTHORIZED = 0x00000002

export interface IssuanceConfig {
  /** Decimal places used for display purposes only; raw amounts are always integer base units. Defaults to 2. */
  assetScale?: number
  /** Maximum amount of the token that can ever be outstanding, as a base-10 string. Defaults to a generous 1e12 base units. */
  maximumAmount?: string
  /** Secondary-sale fee in tenths of a basis point (0-50000). Only meaningful when `transferable` is true. Defaults to 0. */
  transferFee?: number
  /** Whether holders may pay each other directly (not just issuer<->holder). Defaults to true. */
  transferable?: boolean
  /** XLS-89 metadata describing the token; encoded onto MPTokenMetadata. */
  metadata?: MPTokenMetadata
}

export interface HolderStatus {
  /** Whether the holder has an MPToken object at all (i.e. has opted in). */
  exists: boolean
  /** Whether the issuer has authorized (allowlisted) this holder. */
  authorized: boolean
  /** Whether this holder's balance is individually frozen. */
  locked: boolean
  /** Current balance, as a base-10 string of base units. */
  balance: string
}

export interface IssuanceStatus {
  /** Whether the whole token is globally frozen. */
  globallyLocked: boolean
  /** Total amount currently held by non-issuer accounts. */
  outstandingAmount: string
  maximumAmount?: string
}

function isEntryNotFound(err: unknown): boolean {
  if (!(err instanceof RippledError)) return false
  const data = err.data as { error?: string } | undefined
  return data?.error === 'entryNotFound'
}

/**
 * Issuer-side controls for a regulated Multi-Purpose Token (MPT):
 * allowlisting, clawback, bans, per-holder freeze, and global freeze.
 *
 * All mutating methods sign with the issuer's wallet and wait for ledger
 * validation, throwing unless the transaction actually applied with
 * tesSUCCESS - callers can assume a resolved promise means the control took
 * effect on-ledger.
 *
 * Freeze nuance carried over from the protocol itself: a lock (per-holder or
 * global) blocks any transfer that isn't directly to/from the issuer. This is
 * intentional in XRPL's design (it keeps the issuer's own recovery/clawback
 * path open) and mirrors classic trust-line freezes.
 */
export class MptIssuer {
  private readonly bannedHolders = new Set<string>()

  private constructor(
    private readonly client: Client,
    private readonly issuerWallet: Wallet,
    private readonly _issuanceId: string,
  ) {}

  get issuanceId(): string {
    return this._issuanceId
  }

  get issuerAddress(): string {
    return this.issuerWallet.address
  }

  /** Wraps an already-created MPT issuance (e.g. after a backend restart). */
  static existing(client: Client, issuerWallet: Wallet, issuanceId: string): MptIssuer {
    return new MptIssuer(client, issuerWallet, issuanceId)
  }

  /** Creates a new MPT issuance with allowlisting, clawback, and lock (freeze) all enabled. */
  static async issue(client: Client, issuerWallet: Wallet, config: IssuanceConfig = {}): Promise<MptIssuer> {
    const transferable = config.transferable ?? true
    if (config.transferFee && !transferable) {
      throw new Error('transferFee requires transferable to be true (tfMPTCanTransfer)')
    }

    const flags: MPTokenIssuanceCreateFlagsInterface = {
      tfMPTRequireAuth: true,
      tfMPTCanLock: true,
      tfMPTCanClawback: true,
      tfMPTCanTransfer: transferable,
    }

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuerWallet.address,
      AssetScale: config.assetScale ?? 2,
      MaximumAmount: config.maximumAmount ?? '1000000000000',
      TransferFee: config.transferFee ?? 0,
      Flags: flags,
      ...(config.metadata ? { MPTokenMetadata: encodeMPTokenMetadata(config.metadata) } : {}),
    }

    const response = await submitAndCheck(client, tx, issuerWallet)
    const meta = response.result.meta
    const issuanceId = typeof meta === 'string' ? undefined : meta?.mpt_issuance_id
    if (!issuanceId) {
      throw new Error('MPTokenIssuanceCreate succeeded but the ledger did not return an mpt_issuance_id')
    }
    return new MptIssuer(client, issuerWallet, issuanceId)
  }

  /**
   * Allowlist control: authorizes a holder to hold the token. The holder
   * must have already opted in themselves (see `optIntoMpt`) - the issuer
   * cannot create the holder's MPToken object for them.
   */
  async approveHolder(holder: string): Promise<void> {
    if (this.bannedHolders.has(holder)) {
      throw new Error(`Cannot approve ${holder}: this address is banned.`)
    }
    const status = await this.getHolderStatus(holder)
    if (!status.exists) {
      throw new Error(
        `Cannot approve ${holder}: holder has not opted in yet (no MPToken object). ` +
          'The holder must submit their own MPTokenAuthorize transaction first.',
      )
    }
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this._issuanceId,
      Holder: holder,
    }
    await submitAndCheck(this.client, tx, this.issuerWallet)
  }

  /** Issuer-initiated distribution/payment to an approved holder. */
  async sendTo(holder: string, value: string): Promise<void> {
    const tx: Payment = {
      TransactionType: 'Payment',
      Account: this.issuerWallet.address,
      Destination: holder,
      Amount: { mpt_issuance_id: this._issuanceId, value },
    }
    await submitAndCheck(this.client, tx, this.issuerWallet)
  }

  /** Clawback control: claws back `value` base units from `holder`, regardless of any freeze state. */
  async clawback(holder: string, value: string): Promise<void> {
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuerWallet.address,
      Holder: holder,
      Amount: { mpt_issuance_id: this._issuanceId, value },
    }
    await submitAndCheck(this.client, tx, this.issuerWallet)
  }

  /** Per-holder freeze control: locks a single holder's balance. */
  async freezeHolder(holder: string): Promise<void> {
    await this.setHolderLock(holder, true)
  }

  /** Lifts a per-holder freeze. */
  async unfreezeHolder(holder: string): Promise<void> {
    await this.setHolderLock(holder, false)
  }

  /** Global freeze control: locks movement of the token for every holder. */
  async freezeGlobal(): Promise<void> {
    await this.setGlobalLock(true)
  }

  /** Lifts a global freeze. */
  async unfreezeGlobal(): Promise<void> {
    await this.setGlobalLock(false)
  }

  /**
   * Ban control: claws back the holder's entire balance and revokes their
   * allowlist authorization, then remembers them so `approveHolder` refuses
   * to re-admit them from this process going forward. The on-ledger
   * deauthorization (not the in-memory set) is what actually stops them from
   * receiving the token again - a real backend should also persist the ban
   * list externally rather than relying on process memory.
   */
  async ban(holder: string): Promise<void> {
    const status = await this.getHolderStatus(holder)
    if (status.exists) {
      if (status.balance !== '0') {
        await this.clawback(holder, status.balance)
      }
      if (status.authorized) {
        const tx: MPTokenAuthorize = {
          TransactionType: 'MPTokenAuthorize',
          Account: this.issuerWallet.address,
          MPTokenIssuanceID: this._issuanceId,
          Holder: holder,
          Flags: { tfMPTUnauthorize: true },
        }
        await submitAndCheck(this.client, tx, this.issuerWallet)
      }
    }
    this.bannedHolders.add(holder)
  }

  isBanned(holder: string): boolean {
    return this.bannedHolders.has(holder)
  }

  async getHolderStatus(holder: string): Promise<HolderStatus> {
    const entry = await this.fetchHolderEntry(holder)
    if (!entry) {
      return { exists: false, authorized: false, locked: false, balance: '0' }
    }
    return {
      exists: true,
      authorized: (entry.Flags & MPTOKEN_LSF_AUTHORIZED) !== 0,
      locked: (entry.Flags & MPTOKEN_LSF_LOCKED) !== 0,
      balance: entry.MPTAmount ?? '0',
    }
  }

  async getIssuanceStatus(): Promise<IssuanceStatus> {
    const response = await this.client.request({
      command: 'ledger_entry',
      mpt_issuance: this._issuanceId,
    })
    const node = (response.result as { node?: MPTokenIssuance }).node
    if (!node) {
      throw new Error(`MPTokenIssuance ${this._issuanceId} not found`)
    }
    return {
      globallyLocked: (node.Flags & MPTokenIssuanceFlags.lsfMPTLocked) !== 0,
      outstandingAmount: node.OutstandingAmount,
      maximumAmount: node.MaximumAmount,
    }
  }

  private async setHolderLock(holder: string, lock: boolean): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this._issuanceId,
      Holder: holder,
      Flags: lock ? { tfMPTLock: true } : { tfMPTUnlock: true },
    }
    await submitAndCheck(this.client, tx, this.issuerWallet)
  }

  private async setGlobalLock(lock: boolean): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this._issuanceId,
      Flags: lock ? { tfMPTLock: true } : { tfMPTUnlock: true },
    }
    await submitAndCheck(this.client, tx, this.issuerWallet)
  }

  private async fetchHolderEntry(holder: string): Promise<MPToken | undefined> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this._issuanceId, account: holder },
      })
      return (response.result as unknown as { node?: MPToken }).node
    } catch (err) {
      if (isEntryNotFound(err)) return undefined
      throw err
    }
  }
}
