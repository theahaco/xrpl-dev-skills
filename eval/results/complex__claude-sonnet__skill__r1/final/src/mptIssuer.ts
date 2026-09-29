import {
  Client,
  Wallet,
  convertStringToHex,
  encodeMPTokenMetadata,
  parseMPTokenIssuanceFlags,
} from 'xrpl';
import type {
  Clawback,
  LedgerEntry,
  MPTokenAuthorize,
  MPTokenIssuanceCreate,
  MPTokenIssuanceSet,
  MPTokenMetadata,
  Payment,
  SubmittableTransaction,
  TxResponse,
} from 'xrpl';
import { MPTokenAuthorizeFlags, MPTokenIssuanceCreateFlags, MPTokenIssuanceSetFlags } from 'xrpl';
import { MptTransactionError } from './errors';

/**
 * Bit flags on the per-holder `MPToken` ledger object (rippled `LedgerFormats.cpp`).
 * Not exported by the xrpl.js type definitions, so mirrored here.
 */
const MPTOKEN_LSF_LOCKED = 0x0001;
const MPTOKEN_LSF_AUTHORIZED = 0x0002;

export interface CreateIssuanceOptions {
  /** Decimal places used when displaying the token. Does not affect on-ledger integer amounts. */
  assetScale?: number;
  /** Maximum outstanding supply, as an integer string. Defaults to the protocol maximum if omitted. */
  maximumAmount?: string;
  /** Transfer fee in tenths of a basis point (0-50000, i.e. 0%-50%). Only applies to holder-to-holder transfers. */
  transferFee?: number;
  /** On-chain XLS-89d style metadata (ticker, name, icon, asset class, etc). */
  metadata?: MPTokenMetadata;
}

export interface HolderState {
  address: string;
  /** Whether the holder has created their MPToken object via MPTokenAuthorize. */
  optedIn: boolean;
  /** Whether the issuer has authorized this holder (relevant when RequireAuth is set). */
  authorized: boolean;
  /** Whether this holder is individually frozen (locked). */
  frozen: boolean;
  balance: string;
}

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  outstandingAmount: string;
  globallyFrozen: boolean;
  requiresAuth: boolean;
  canClawback: boolean;
  canLock: boolean;
}

/**
 * Reusable issuer-side controller for a compliance-controlled Multi-Purpose Token (MPT).
 *
 * Every write method signs and submits with the issuer's wallet, waits for ledger
 * validation, and throws {@link MptTransactionError} on any non-tesSUCCESS result.
 * Holders authorize themselves (see {@link holderOptIn}) since that transaction must be
 * signed by the holder's own key, which this issuer-scoped class never has access to.
 */
export class MptIssuer {
  constructor(
    private readonly client: Client,
    private readonly issuerWallet: Wallet,
  ) {}

  get issuerAddress(): string {
    return this.issuerWallet.address;
  }

  /**
   * Creates a new MPT issuance with every compliance control enabled:
   * RequireAuth (allowlist), CanLock (freeze/global freeze), CanClawback, CanTransfer.
   * Returns the MPTokenIssuanceID.
   */
  async createIssuance(options: CreateIssuanceOptions = {}): Promise<string> {
    const flags =
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback |
      MPTokenIssuanceCreateFlags.tfMPTCanTransfer;

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.issuerAddress,
      AssetScale: options.assetScale ?? 0,
      TransferFee: options.transferFee ?? 0,
      Flags: flags,
      ...(options.maximumAmount !== undefined ? { MaximumAmount: options.maximumAmount } : {}),
      ...(options.metadata !== undefined
        ? { MPTokenMetadata: encodeMPTokenMetadata(options.metadata) }
        : {}),
    };

    const response = await this.submit(tx);
    const meta = response.result.meta as { mpt_issuance_id?: string };
    const issuanceId = meta.mpt_issuance_id;
    if (!issuanceId) {
      throw new MptTransactionError(
        'MPTokenIssuanceCreate succeeded but the ledger did not return an mpt_issuance_id',
        tx.TransactionType,
        'tesSUCCESS',
        response.result.hash,
      );
    }
    return issuanceId;
  }

  /** Allowlist control: grants a KYC-approved holder permission to hold the token. */
  async approveHolder(issuanceId: string, holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
    };
    await this.submit(tx);
  }

  /**
   * Allowlist control: revokes a holder's authorization so they can no longer receive
   * the token. Does not affect any balance they already hold — pair with {@link clawback}
   * (or use {@link banHolder}) to also strip an existing balance.
   */
  async revokeHolderAuthorization(issuanceId: string, holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    };
    await this.submit(tx);
  }

  /** Issues (or pays out) `value` of the token from the issuer to an approved holder. */
  async sendTokens(issuanceId: string, holderAddress: string, value: string): Promise<void> {
    // rippled's MPT lock only blocks the locked holder's own outgoing sends and use as
    // a payment-path intermediary — an issuer-initiated deposit to a locked holder is
    // NOT rejected at the protocol level. That leaves a gap versus "a frozen holder
    // can't receive the token", so this guard enforces it at the application layer
    // before a transaction is even submitted.
    const [holder, issuance] = await Promise.all([
      this.getHolderState(issuanceId, holderAddress),
      this.getIssuanceState(issuanceId),
    ]);
    if (issuance.globallyFrozen) {
      throw new MptTransactionError(
        `Cannot send: MPTokenIssuance ${issuanceId} is globally frozen`,
        'Payment',
        'APP_GLOBAL_FROZEN',
      );
    }
    if (holder.frozen) {
      throw new MptTransactionError(`Cannot send: holder ${holderAddress} is frozen`, 'Payment', 'APP_HOLDER_FROZEN');
    }

    const tx: Payment = {
      TransactionType: 'Payment',
      Account: this.issuerAddress,
      Destination: holderAddress,
      Amount: { mpt_issuance_id: issuanceId, value },
    };
    await this.submit(tx);
  }

  /** Clawback control: seizes `value` of the token from a holder back to the issuer. */
  async clawback(issuanceId: string, holderAddress: string, value: string): Promise<void> {
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: issuanceId, value },
    };
    await this.submit(tx);
  }

  /** Per-holder freeze: blocks this holder from sending or receiving the token. */
  async freezeHolder(issuanceId: string, holderAddress: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTLock, holderAddress);
  }

  /** Lifts a per-holder freeze. */
  async unfreezeHolder(issuanceId: string, holderAddress: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTUnlock, holderAddress);
  }

  /** Global freeze: blocks all movement of the token, for every holder. */
  async globalFreeze(issuanceId: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTLock);
  }

  /** Lifts a global freeze. */
  async globalUnfreeze(issuanceId: string): Promise<void> {
    await this.setLock(issuanceId, MPTokenIssuanceSetFlags.tfMPTUnlock);
  }

  /**
   * Ban control: seizes the holder's entire balance (if any) and revokes their
   * authorization, so they end up holding none of the token and cannot receive it again.
   */
  async banHolder(issuanceId: string, holderAddress: string): Promise<void> {
    const holder = await this.getHolderState(issuanceId, holderAddress);
    if (holder.optedIn && BigInt(holder.balance) > 0n) {
      await this.clawback(issuanceId, holderAddress, holder.balance);
    }
    await this.revokeHolderAuthorization(issuanceId, holderAddress);
  }

  /** Reads a holder's current opt-in, authorization, freeze, and balance state. */
  async getHolderState(issuanceId: string, holderAddress: string): Promise<HolderState> {
    const { result } = await this.client.request({
      command: 'account_objects',
      account: holderAddress,
      type: 'mptoken',
      ledger_index: 'validated',
    });
    // account_objects with type: 'mptoken' can only return MPToken entries, but the
    // installed xrpl version's AccountObject union omits MPToken (only MPTokenIssuance
    // is wired in), so we narrow via an unknown cast instead of a type predicate.
    const entry = result.account_objects.find((obj) => {
      const candidate = obj as unknown as { LedgerEntryType: string; MPTokenIssuanceID: string };
      return candidate.LedgerEntryType === 'MPToken' && candidate.MPTokenIssuanceID === issuanceId;
    }) as unknown as LedgerEntry.MPToken | undefined;
    if (!entry) {
      return { address: holderAddress, optedIn: false, authorized: false, frozen: false, balance: '0' };
    }
    return {
      address: holderAddress,
      optedIn: true,
      authorized: (entry.Flags & MPTOKEN_LSF_AUTHORIZED) !== 0,
      frozen: (entry.Flags & MPTOKEN_LSF_LOCKED) !== 0,
      // rippled omits MPTAmount from the JSON entirely when the balance is 0.
      balance: entry.MPTAmount ?? '0',
    };
  }

  /** Reads the issuance's current supply and global freeze/control-flag state. */
  async getIssuanceState(issuanceId: string): Promise<IssuanceState> {
    const { result } = await this.client.request({
      command: 'account_objects',
      account: this.issuerAddress,
      type: 'mpt_issuance',
      ledger_index: 'validated',
    });
    // rippled reports the issuance's mpt_issuance_id as an extra field alongside the
    // MPTokenIssuance object; it is not the same as the object's ledger `index` and is
    // not present in the xrpl.js type definitions, so it's read via an unknown cast.
    const entry = result.account_objects.find((obj) => {
      const candidate = obj as unknown as { LedgerEntryType: string; mpt_issuance_id?: string };
      return candidate.LedgerEntryType === 'MPTokenIssuance' && candidate.mpt_issuance_id === issuanceId;
    }) as LedgerEntry.MPTokenIssuance | undefined;
    if (!entry) {
      throw new Error(`MPTokenIssuance ${issuanceId} not found for issuer ${this.issuerAddress}`);
    }
    const flags = parseMPTokenIssuanceFlags(entry.Flags);
    return {
      issuanceId,
      issuer: entry.Issuer,
      outstandingAmount: entry.OutstandingAmount ?? '0',
      globallyFrozen: Boolean(flags.lsfMPTLocked),
      requiresAuth: Boolean(flags.lsfMPTRequireAuth),
      canClawback: Boolean(flags.lsfMPTCanClawback),
      canLock: Boolean(flags.lsfMPTCanLock),
    };
  }

  private async setLock(
    issuanceId: string,
    flag: MPTokenIssuanceSetFlags.tfMPTLock | MPTokenIssuanceSetFlags.tfMPTUnlock,
    holderAddress?: string,
  ): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Flags: flag,
      ...(holderAddress !== undefined ? { Holder: holderAddress } : {}),
    };
    await this.submit(tx);
  }

  private async submit<T extends SubmittableTransaction>(tx: T): Promise<TxResponse<T>> {
    return submitAndCheck(this.client, this.issuerWallet, tx);
  }
}

/**
 * Signs `tx` with `wallet`, submits it, waits for ledger validation, and throws
 * {@link MptTransactionError} unless the transaction validated with `tesSUCCESS`.
 * Exported so callers (e.g. a holder submitting their own MPTokenAuthorize) get the
 * same reliability guarantees as the issuer's own transactions.
 */
export async function submitAndCheck<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { wallet });
  const meta = response.result.meta;
  if (typeof meta !== 'object' || meta === null) {
    throw new MptTransactionError(
      `${tx.TransactionType} returned no transaction metadata`,
      tx.TransactionType,
      'UNKNOWN',
      response.result.hash,
    );
  }
  const code = (meta as { TransactionResult: string }).TransactionResult;
  if (code !== 'tesSUCCESS') {
    throw new MptTransactionError(`${tx.TransactionType} failed with ${code}`, tx.TransactionType, code, response.result.hash);
  }
  if (!response.result.validated) {
    throw new MptTransactionError(`${tx.TransactionType} was not validated`, tx.TransactionType, code, response.result.hash);
  }
  return response;
}

/** Convenience re-export so callers don't need a second import from 'xrpl' for hex encoding. */
export { convertStringToHex };
