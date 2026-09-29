import {
  Client,
  Wallet,
  RippledError,
  encodeMPTokenMetadata,
  parseMPTokenIssuanceFlags,
} from 'xrpl';
import type {
  MPTokenIssuanceCreate,
  MPTokenAuthorize,
  MPTokenIssuanceSet,
  Clawback,
  Payment,
  SubmittableTransaction,
  TxResponse,
  MPTokenMetadata,
  LedgerEntry,
} from 'xrpl';
import { MptIssuerError } from './errors';

/**
 * MPToken (holder-level) ledger entry flags. These are defined by the
 * XLS-33d amendment but xrpl.js does not export a named enum for them
 * (only the issuance-level `MPTokenIssuanceFlags` is exported), so they
 * are reproduced here from ripple-binary-codec's LEDGER_ENTRY_FLAGS.MPToken.
 */
const LSF_MPT_LOCKED = 0x00000001;
const LSF_MPT_AUTHORIZED = 0x00000002;

export interface CreateIssuanceParams {
  /** Decimal places used to display the integer ledger amount. Defaults to 0 (whole units only). */
  assetScale?: number;
  /** Maximum outstanding amount, as an integer string in the smallest unit. Omit for no cap. */
  maximumAmount?: string;
  /** Transfer fee in tenths of a basis point (0-50000 = 0%-50%). */
  transferFee?: number;
  /** Structured MPT metadata; will be hex-encoded onto the ledger. */
  metadata?: MPTokenMetadata;
}

export interface HolderMptState {
  /** Whether the holder has opted in (i.e. an MPToken object exists for them). */
  exists: boolean;
  /** Current balance, as an integer string in the smallest unit. */
  balance: string;
  /** Whether the issuer has authorized this holder (relevant only because the issuance requires auth). */
  authorized: boolean;
  /** Whether this holder is individually frozen. */
  frozen: boolean;
}

export interface IssuanceMptState {
  issuanceId: string;
  issuer: string;
  /** Total outstanding amount, as an integer string in the smallest unit. */
  outstandingAmount: string;
  /** Whether the whole issuance is globally frozen. */
  globallyLocked: boolean;
  requireAuth: boolean;
  canClawback: boolean;
  canLock: boolean;
  canTransfer: boolean;
}

function isEntryNotFoundError(error: unknown): boolean {
  if (!(error instanceof RippledError)) {
    return false;
  }
  const data = error.data as { error?: string } | undefined;
  return data?.error === 'entryNotFound';
}

/**
 * Issuer-side controller for a single regulated Multi-Purpose Token (MPT)
 * issuance on the XRP Ledger. Wraps the transactions needed to operate a
 * compliant, stablecoin-style token: a KYC allowlist, clawback, address
 * bans, per-holder freeze, and a global freeze switch.
 *
 * One instance manages exactly one issuance. Construct it with the
 * issuance ID once known (via `createIssuance` or the constructor's
 * `issuanceId` argument).
 */
export class MptIssuer {
  readonly client: Client;
  readonly issuerWallet: Wallet;
  private _issuanceId: string | undefined;

  constructor(client: Client, issuerWallet: Wallet, issuanceId?: string) {
    this.client = client;
    this.issuerWallet = issuerWallet;
    this._issuanceId = issuanceId;
  }

  /** The managed issuance's ID. Throws if `createIssuance` has not been called yet. */
  get issuanceId(): string {
    if (!this._issuanceId) {
      throw new Error('No MPT issuance associated with this MptIssuer yet; call createIssuance() first');
    }
    return this._issuanceId;
  }

  private async submit<T extends SubmittableTransaction>(
    transaction: T,
    signer: Wallet = this.issuerWallet,
  ): Promise<TxResponse<T>> {
    const response = await this.client.submitAndWait(transaction, { wallet: signer });
    const meta = response.result.meta;
    const engineResult = meta && typeof meta === 'object' ? meta.TransactionResult : undefined;
    if (engineResult !== 'tesSUCCESS') {
      throw new MptIssuerError(
        transaction.TransactionType,
        engineResult,
        `${transaction.TransactionType} failed with result ${engineResult ?? '(no metadata returned)'}`,
      );
    }
    return response;
  }

  /**
   * Creates the MPT issuance with every compliance control this module
   * supports enabled: lockable (for freezes), clawback-able, and
   * requiring issuer authorization (the allowlist). Transfer between
   * holders is also enabled, matching stablecoin-style usage.
   */
  async createIssuance(params: CreateIssuanceParams = {}): Promise<string> {
    if (this._issuanceId) {
      throw new Error(`This MptIssuer already manages issuance ${this._issuanceId}`);
    }

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.issuerWallet.address,
      AssetScale: params.assetScale ?? 0,
      ...(params.maximumAmount !== undefined ? { MaximumAmount: params.maximumAmount } : {}),
      ...(params.transferFee !== undefined ? { TransferFee: params.transferFee } : {}),
      ...(params.metadata !== undefined ? { MPTokenMetadata: encodeMPTokenMetadata(params.metadata) } : {}),
      Flags: {
        tfMPTCanLock: true,
        tfMPTRequireAuth: true,
        tfMPTCanClawback: true,
        tfMPTCanTransfer: true,
      },
    };

    const response = await this.submit(tx);
    const meta = response.result.meta as Record<string, unknown> | undefined;
    const issuanceId = typeof meta?.mpt_issuance_id === 'string' ? meta.mpt_issuance_id : undefined;
    if (!issuanceId) {
      throw new MptIssuerError(
        'MPTokenIssuanceCreate',
        'tesSUCCESS',
        'MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned in the transaction metadata',
      );
    }
    this._issuanceId = issuanceId;
    return issuanceId;
  }

  /**
   * Allowlist a holder who has already opted in (see the standalone
   * `optInHolder` function). Required before that holder can receive any
   * of the token, since the issuance is created with `tfMPTRequireAuth`.
   */
  async approveHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
    };
    await this.submit(tx);
  }

  /**
   * Remove a holder from the allowlist. They keep whatever balance they
   * currently hold (clawback separately if the balance must go to zero)
   * but can no longer receive any more of the token.
   */
  async revokeHolderApproval(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    };
    await this.submit(tx);
  }

  /** Sends `amount` (integer string, smallest unit) of the token from the issuer to `holderAddress`. */
  async pay(holderAddress: string, amount: string): Promise<void> {
    const tx: Payment = {
      TransactionType: 'Payment',
      Account: this.issuerWallet.address,
      Destination: holderAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value: amount },
    };
    await this.submit(tx);
  }

  /** Claws back `amount` (integer string, smallest unit) of the token from `holderAddress`. */
  async clawback(holderAddress: string, amount: string): Promise<void> {
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuerWallet.address,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value: amount },
    };
    await this.submit(tx);
  }

  /** Freezes a single holder: they can neither send nor receive the token. */
  async freezeHolder(holderAddress: string): Promise<void> {
    // rippled's per-holder lock (lsfMPTLocked) only blocks that holder from
    // *sending*; a locked holder can still receive. To meet "can't send or
    // receive", we also revoke their allowlist authorization, which blocks
    // both directions (RequireAuth gates all movement touching an
    // unauthorized holder, not just new incoming funds).
    await this.submit<MPTokenIssuanceSet>({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTLock: true },
    });
    await this.submit<MPTokenAuthorize>({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    });
  }

  /** Lifts an individual holder's freeze, restoring their allowlist authorization. */
  async unfreezeHolder(holderAddress: string): Promise<void> {
    await this.submit<MPTokenIssuanceSet>({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTUnlock: true },
    });
    await this.submit<MPTokenAuthorize>({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
    });
  }

  /**
   * Freezes all holder-initiated movement of the token, e.g. during an
   * incident. Blocks every holder from sending. Issuer-initiated actions
   * (payments out, clawback) remain available throughout, since the
   * issuer is the trusted party invoking the freeze in the first place.
   */
  async globalFreeze(): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: { tfMPTLock: true },
    };
    await this.submit(tx);
  }

  /** Lifts the global freeze. */
  async globalUnfreeze(): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: { tfMPTUnlock: true },
    };
    await this.submit(tx);
  }

  /**
   * Bans an address: claws back its entire balance (if any) and removes
   * it from the allowlist, so it ends up holding none of the token and
   * cannot be authorized to receive it again without a fresh, explicit
   * `approveHolder` call.
   */
  async banHolder(holderAddress: string): Promise<void> {
    const state = await this.getHolderState(holderAddress);
    if (state.exists && BigInt(state.balance) > 0n) {
      await this.clawback(holderAddress, state.balance);
    }
    if (state.exists && state.authorized) {
      await this.revokeHolderApproval(holderAddress);
    }
  }

  /** Reads a holder's current balance, authorization, and freeze status for this issuance. */
  async getHolderState(holderAddress: string): Promise<HolderMptState> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.issuanceId, account: holderAddress },
      });
      const node = response.result.node as unknown as LedgerEntry.MPToken;
      return {
        exists: true,
        // rippled omits MPTAmount entirely once a balance is clawed back to zero.
        balance: node.MPTAmount ?? '0',
        authorized: (node.Flags & LSF_MPT_AUTHORIZED) !== 0,
        frozen: (node.Flags & LSF_MPT_LOCKED) !== 0,
      };
    } catch (error) {
      if (isEntryNotFoundError(error)) {
        return { exists: false, balance: '0', authorized: false, frozen: false };
      }
      throw error;
    }
  }

  /** Reads the issuance's outstanding supply and control-flag state. */
  async getIssuanceState(): Promise<IssuanceMptState> {
    const response = await this.client.request({
      command: 'ledger_entry',
      mpt_issuance: this.issuanceId,
    });
    const node = response.result.node as unknown as LedgerEntry.MPTokenIssuance;
    const flags = parseMPTokenIssuanceFlags(node.Flags);
    return {
      issuanceId: this.issuanceId,
      issuer: node.Issuer,
      // rippled omits OutstandingAmount entirely when it is zero.
      outstandingAmount: node.OutstandingAmount ?? '0',
      globallyLocked: Boolean(flags.lsfMPTLocked),
      requireAuth: Boolean(flags.lsfMPTRequireAuth),
      canClawback: Boolean(flags.lsfMPTCanClawback),
      canLock: Boolean(flags.lsfMPTCanLock),
      canTransfer: Boolean(flags.lsfMPTCanTransfer),
    };
  }
}

/**
 * Holder-signed opt-in/opt-out. A holder must call this (with
 * `unauthorize: false`, the default) before the issuer can `approveHolder`
 * them or send them any of the token. Pass `unauthorize: true` for a
 * holder to voluntarily give up their MPToken object (only possible when
 * their balance is zero).
 */
export async function optInHolder(
  client: Client,
  holderWallet: Wallet,
  issuanceId: string,
  unauthorize = false,
): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
    ...(unauthorize ? { Flags: { tfMPTUnauthorize: true } } : {}),
  };
  const response = await client.submitAndWait(tx, { wallet: holderWallet });
  const meta = response.result.meta;
  const engineResult = meta && typeof meta === 'object' ? meta.TransactionResult : undefined;
  if (engineResult !== 'tesSUCCESS') {
    throw new MptIssuerError(
      'MPTokenAuthorize',
      engineResult,
      `Holder opt-in failed with result ${engineResult ?? '(no metadata returned)'}`,
    );
  }
}

export { MptIssuerError } from './errors';
