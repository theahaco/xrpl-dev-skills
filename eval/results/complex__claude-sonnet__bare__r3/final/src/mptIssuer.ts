/**
 * Issuer-side controls for a regulated Multi-Purpose Token (MPT) on the XRP Ledger.
 *
 * The issuance is created with:
 *   - tfMPTRequireAuth  -> allowlist: only issuer-approved holders can hold the token
 *   - tfMPTCanLock      -> per-holder and global freeze
 *   - tfMPTCanClawback  -> issuer can claw back tokens from any holder
 *   - tfMPTCanTransfer  -> the token can move between non-issuer accounts
 *
 * "Ban" is not a native MPT primitive. It is implemented here as the composition of the
 * three primitives above: sweep the holder's balance to zero (Clawback), lock their
 * MPToken so it can't move (MPTokenIssuanceSet + Holder), and revoke their allowlist
 * authorization (MPTokenAuthorize + tfMPTUnauthorize) so RequireAuth blocks any future
 * incoming payment. A banned holder is also recorded so this module refuses to
 * re-approve them later, even though nothing here would resurrect the address on its own.
 */

import {
  Client,
  Wallet,
  Payment,
  Clawback,
  MPTokenAuthorize,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreate,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSet,
  MPTokenIssuanceSetFlags,
  SubmittableTransaction,
  TxResponse,
} from 'xrpl';

/** Anything that can hold/receive an amount: a full Wallet, or just a classic address string. */
export type Holder = Wallet | string;

function holderAddress(holder: Holder): string {
  return typeof holder === 'string' ? holder : holder.address;
}

export interface CreateIssuanceOptions {
  /** Decimal places used only for display; the ledger stores integer base units. Default 0. */
  assetScale?: number;
  /** Maximum issuable amount, as a base-10 string. Default: no practical cap (2^63-1). */
  maximumAmount?: string;
  /** Arbitrary metadata (e.g. `{"name":"Example USD","ticker":"EUSD"}`), stored as hex on ledger. */
  metadata?: string | Record<string, unknown>;
  /** Transfer fee in 0.001% units (0-50000). Requires transfers to be enabled. Default 0. */
  transferFee?: number;
}

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  outstandingAmount: string;
  maximumAmount?: string;
  globallyLocked: boolean;
  requireAuth: boolean;
  canClawback: boolean;
  canLock: boolean;
  canTransfer: boolean;
}

export interface HolderState {
  holder: string;
  issuanceId: string;
  /** False if the holder has never opted in (no MPToken object exists on ledger). */
  exists: boolean;
  balance: string;
  authorized: boolean;
  locked: boolean;
}

/** Minimal shape we read off account_objects results; the SDK's ledger-entry types are internal. */
interface RawMptIssuanceLedgerEntry {
  LedgerEntryType: 'MPTokenIssuance';
  mpt_issuance_id?: string;
  Issuer: string;
  Flags: number;
  OutstandingAmount: string;
  MaximumAmount?: string;
}

interface RawMptTokenLedgerEntry {
  LedgerEntryType: 'MPToken';
  Account: string;
  MPTokenIssuanceID: string;
  MPTAmount?: string;
  Flags: number;
}

const MPT_ISSUANCE_LOCKED = 0x00000001; // lsfMPTLocked on MPTokenIssuance
const MPT_ISSUANCE_REQUIRE_AUTH = 0x00000004; // lsfMPTRequireAuth
const MPT_ISSUANCE_CAN_CLAWBACK = 0x00000040; // lsfMPTCanClawback
const MPT_ISSUANCE_CAN_LOCK = 0x00000002; // lsfMPTCanLock
const MPT_ISSUANCE_CAN_TRANSFER = 0x00000020; // lsfMPTCanTransfer

const MPTOKEN_LOCKED = 0x00000001; // lsfMPTLocked on MPToken
const MPTOKEN_AUTHORIZED = 0x00000002; // lsfMPTAuthorized on MPToken

function hasFlag(flags: number, bit: number): boolean {
  return (flags & bit) === bit;
}

function utf8ToHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex').toUpperCase();
}

/** Thrown when a submitted transaction lands on-ledger but does not succeed (non-tes* result). */
export class MptTransactionError extends Error {
  constructor(
    public readonly transactionType: string,
    public readonly transactionResult: string,
    public readonly txHash?: string,
  ) {
    super(
      `${transactionType} failed with ${transactionResult}${txHash ? ` (tx ${txHash})` : ''}`,
    );
    this.name = 'MptTransactionError';
  }
}

/** Thrown when trying to approve a holder this module has previously banned. */
export class HolderBannedError extends Error {
  constructor(public readonly holder: string) {
    super(`Holder ${holder} has been banned and cannot be re-approved by this module instance`);
    this.name = 'HolderBannedError';
  }
}

export class MptIssuer {
  private readonly bannedHolders = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly issuer: Wallet,
  ) {}

  get issuerAddress(): string {
    return this.issuer.address;
  }

  /** Signs and submits a transaction from the issuer's wallet, waits for validation, and throws unless it succeeded. */
  private async submitAsIssuer<T extends SubmittableTransaction>(tx: T): Promise<TxResponse<T>> {
    return submitAndAssertSuccess(this.client, this.issuer, tx);
  }

  // ---------------------------------------------------------------------
  // Issuance lifecycle
  // ---------------------------------------------------------------------

  /** Creates the MPT issuance with allowlist, freeze, and clawback all enabled. Returns the new issuance ID. */
  async createIssuance(options: CreateIssuanceOptions = {}): Promise<string> {
    const metadataHex =
      options.metadata === undefined
        ? undefined
        : typeof options.metadata === 'string'
          ? options.metadata
          : utf8ToHex(JSON.stringify(options.metadata));

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.issuer.address,
      AssetScale: options.assetScale ?? 0,
      ...(options.maximumAmount !== undefined ? { MaximumAmount: options.maximumAmount } : {}),
      ...(options.transferFee !== undefined ? { TransferFee: options.transferFee } : {}),
      ...(metadataHex !== undefined ? { MPTokenMetadata: metadataHex } : {}),
      Flags:
        MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanLock |
        MPTokenIssuanceCreateFlags.tfMPTCanClawback |
        MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
    };

    const response = await this.submitAsIssuer(tx);
    const meta = response.result.meta;
    const issuanceId =
      meta && typeof meta === 'object' && 'mpt_issuance_id' in meta
        ? (meta as { mpt_issuance_id?: string }).mpt_issuance_id
        : undefined;
    if (!issuanceId) {
      throw new Error('MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned');
    }
    return issuanceId;
  }

  // ---------------------------------------------------------------------
  // Allowlist (KYC gate)
  // ---------------------------------------------------------------------

  /**
   * Approves a holder who has already opted in (see `optInToMpt`) to hold this MPT.
   * Call this only after your KYC process has cleared the holder.
   */
  async approveHolder(holder: Holder, issuanceId: string): Promise<void> {
    const address = holderAddress(holder);
    if (this.bannedHolders.has(address)) {
      throw new HolderBannedError(address);
    }
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer.address,
      MPTokenIssuanceID: issuanceId,
      Holder: address,
    };
    await this.submitAsIssuer(tx);
  }

  /** Revokes a holder's allowlist authorization without touching their balance or lock state. */
  async revokeHolderAuthorization(holder: Holder, issuanceId: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress(holder),
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    };
    await this.submitAsIssuer(tx);
  }

  // ---------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------

  /** Sends `value` base units of the MPT from the issuer to an approved holder. */
  async sendFromIssuer(to: Holder, issuanceId: string, value: string): Promise<void> {
    const tx: Payment = {
      TransactionType: 'Payment',
      Account: this.issuer.address,
      Destination: holderAddress(to),
      Amount: { mpt_issuance_id: issuanceId, value },
    };
    await this.submitAsIssuer(tx);
  }

  // ---------------------------------------------------------------------
  // Clawback
  // ---------------------------------------------------------------------

  /** Claws back `value` base units of the MPT from a holder. If it exceeds their balance, the whole balance is taken. */
  async clawback(holder: Holder, issuanceId: string, value: string): Promise<void> {
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuer.address,
      Holder: holderAddress(holder),
      Amount: { mpt_issuance_id: issuanceId, value },
    };
    await this.submitAsIssuer(tx);
  }

  /** Claws back a holder's entire current balance. No-ops if they hold none (or never opted in). */
  async clawbackAll(holder: Holder, issuanceId: string): Promise<void> {
    const address = holderAddress(holder);
    const state = await this.getHolderState(address, issuanceId);
    if (!state.exists || state.balance === '0') {
      return;
    }
    await this.clawback(address, issuanceId, state.balance);
  }

  // ---------------------------------------------------------------------
  // Per-holder freeze
  // ---------------------------------------------------------------------

  async freezeHolder(holder: Holder, issuanceId: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTLock, holderAddress(holder));
  }

  async unfreezeHolder(holder: Holder, issuanceId: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTUnlock, holderAddress(holder));
  }

  // ---------------------------------------------------------------------
  // Global freeze
  // ---------------------------------------------------------------------

  async freezeGlobal(issuanceId: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTLock);
  }

  async unfreezeGlobal(issuanceId: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTUnlock);
  }

  private async setLock(
    issuanceId: string,
    flag: MPTokenIssuanceSetFlags.tfMPTLock | MPTokenIssuanceSetFlags.tfMPTUnlock,
    holder?: string,
  ): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer.address,
      MPTokenIssuanceID: issuanceId,
      Flags: flag,
      ...(holder !== undefined ? { Holder: holder } : {}),
    };
    await this.submitAsIssuer(tx);
  }

  // ---------------------------------------------------------------------
  // Ban: hold none, and can never receive again
  // ---------------------------------------------------------------------

  /**
   * Bans a holder: sweeps their balance to zero, locks their MPToken so it cannot move,
   * and revokes their allowlist authorization so they cannot be paid again while
   * RequireAuth is enforced. The holder is also remembered so `approveHolder` refuses
   * to re-admit them later via this module instance.
   *
   * In a production deployment, back this module's banned-holder set with persistent
   * storage (e.g. a database row per holder) rather than the in-memory Set used here,
   * so the ban survives a process restart.
   */
  async banHolder(holder: Holder, issuanceId: string): Promise<void> {
    const address = holderAddress(holder);
    await this.clawbackAll(address, issuanceId);
    const state = await this.getHolderState(address, issuanceId);
    if (state.exists && !state.locked) {
      await this.freezeHolder(address, issuanceId);
    }
    if (state.exists && state.authorized) {
      await this.revokeHolderAuthorization(address, issuanceId);
    }
    this.bannedHolders.add(address);
  }

  isBanned(holder: Holder): boolean {
    return this.bannedHolders.has(holderAddress(holder));
  }

  // ---------------------------------------------------------------------
  // Read-side helpers (useful for compliance reporting/audits)
  // ---------------------------------------------------------------------

  async getIssuanceState(issuanceId: string): Promise<IssuanceState> {
    const entry = await this.findLedgerEntry<RawMptIssuanceLedgerEntry>(
      this.issuer.address,
      'mpt_issuance',
      (obj) => obj.mpt_issuance_id === issuanceId || true,
    );
    if (!entry) {
      throw new Error(`MPTokenIssuance ${issuanceId} not found under issuer ${this.issuer.address}`);
    }
    return {
      issuanceId,
      issuer: entry.Issuer,
      outstandingAmount: entry.OutstandingAmount,
      maximumAmount: entry.MaximumAmount,
      globallyLocked: hasFlag(entry.Flags, MPT_ISSUANCE_LOCKED),
      requireAuth: hasFlag(entry.Flags, MPT_ISSUANCE_REQUIRE_AUTH),
      canClawback: hasFlag(entry.Flags, MPT_ISSUANCE_CAN_CLAWBACK),
      canLock: hasFlag(entry.Flags, MPT_ISSUANCE_CAN_LOCK),
      canTransfer: hasFlag(entry.Flags, MPT_ISSUANCE_CAN_TRANSFER),
    };
  }

  async getHolderState(holder: Holder, issuanceId: string): Promise<HolderState> {
    const address = holderAddress(holder);
    const entry = await this.findLedgerEntry<RawMptTokenLedgerEntry>(
      address,
      'mptoken',
      (obj) => obj.MPTokenIssuanceID === issuanceId,
    );
    if (!entry) {
      return { holder: address, issuanceId, exists: false, balance: '0', authorized: false, locked: false };
    }
    return {
      holder: address,
      issuanceId,
      exists: true,
      balance: entry.MPTAmount ?? '0',
      authorized: hasFlag(entry.Flags, MPTOKEN_AUTHORIZED),
      locked: hasFlag(entry.Flags, MPTOKEN_LOCKED),
    };
  }

  private async findLedgerEntry<T>(
    account: string,
    type: 'mptoken' | 'mpt_issuance',
    predicate: (obj: T) => boolean,
  ): Promise<T | undefined> {
    const response = await this.client.request({
      command: 'account_objects',
      account,
      type,
      ledger_index: 'validated',
    });
    const objects = response.result.account_objects as unknown as T[];
    return objects.find(predicate);
  }
}

// ---------------------------------------------------------------------
// Holder-side helper
// ---------------------------------------------------------------------

/**
 * Opts a holder in to an MPT issuance. This must be signed by the holder themselves
 * (self-custody) before the issuer can approve them with `MptIssuer.approveHolder`.
 */
export async function optInToMpt(client: Client, holder: Wallet, issuanceId: string): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.address,
    MPTokenIssuanceID: issuanceId,
  };
  await submitAndAssertSuccess(client, holder, tx);
}

// ---------------------------------------------------------------------
// Shared submit helper
// ---------------------------------------------------------------------

export async function submitAndAssertSuccess<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const response = await client.submitAndWait<T>(signed.tx_blob);
  const meta = response.result.meta;
  const transactionResult =
    meta && typeof meta === 'object' && 'TransactionResult' in meta
      ? (meta as { TransactionResult: string }).TransactionResult
      : undefined;
  if (transactionResult !== 'tesSUCCESS') {
    throw new MptTransactionError(
      tx.TransactionType,
      transactionResult ?? 'UNKNOWN',
      response.result.hash,
    );
  }
  return response as TxResponse<T>;
}
