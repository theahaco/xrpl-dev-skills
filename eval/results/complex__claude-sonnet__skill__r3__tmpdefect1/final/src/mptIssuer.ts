import type { Client, Wallet } from "xrpl";
import {
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  MPTokenAuthorizeFlags,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceSet,
  type MPTokenAuthorize,
  type Clawback,
  type Payment,
} from "xrpl";
import { submitAndRequireSuccess, type SubmitOutcome } from "./txSubmit";
import { getHolderState, getIssuanceState, type HolderState, type IssuanceState } from "./mptState";

export interface CreateIssuanceParams {
  /** Decimal places for display purposes. Does not affect on-ledger integer amounts. */
  assetScale?: number;
  /** Hard cap on total outstanding amount, as an unsigned integer string. */
  maximumAmount?: string;
  /** Transfer fee in tenths of a basis point (0-50000, i.e. 0%-50%). */
  transferFee?: number;
  /** Opaque metadata. Plain strings are UTF-8 hex-encoded automatically; pass hex directly to skip that. */
  metadata?: string;
  /** Allow holder-to-holder transfers, not just issuer<->holder. Defaults to true. */
  allowHolderToHolderTransfer?: boolean;
}

function toHex(input: string): string {
  return /^[0-9A-Fa-f]*$/.test(input) && input.length % 2 === 0 ? input : Buffer.from(input, "utf8").toString("hex").toUpperCase();
}

/**
 * Issuer-side controller for a single regulated MPT issuance.
 *
 * Every mutating method submits exactly one transaction and throws unless it
 * lands on-ledger with `tesSUCCESS` -- there is no silent partial failure.
 * All amounts are unsigned-integer strings in the token's base unit (no
 * floating point), matching MPT's native representation.
 */
export class MPTIssuer {
  readonly client: Client;
  readonly issuerWallet: Wallet;
  readonly issuanceId: string;

  private constructor(client: Client, issuerWallet: Wallet, issuanceId: string) {
    this.client = client;
    this.issuerWallet = issuerWallet;
    this.issuanceId = issuanceId;
  }

  /**
   * Creates a new MPT issuance with every compliance control enabled:
   * allowlist (RequireAuth), per-holder/global freeze (CanLock), and
   * clawback (CanClawback). Returns a controller bound to the new issuance.
   */
  static async create(client: Client, issuerWallet: Wallet, params: CreateIssuanceParams = {}): Promise<MPTIssuer> {
    const allowTransfer = params.allowHolderToHolderTransfer ?? true;

    const flags: MPTokenIssuanceCreateFlags[] = [
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
      MPTokenIssuanceCreateFlags.tfMPTCanLock,
      MPTokenIssuanceCreateFlags.tfMPTCanClawback,
    ];
    if (allowTransfer) {
      flags.push(MPTokenIssuanceCreateFlags.tfMPTCanTransfer);
    }

    const tx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuerWallet.address,
      Flags: flags.reduce((acc, f) => acc | f, 0),
      ...(params.assetScale !== undefined ? { AssetScale: params.assetScale } : {}),
      ...(params.maximumAmount !== undefined ? { MaximumAmount: params.maximumAmount } : {}),
      ...(params.transferFee !== undefined ? { TransferFee: params.transferFee } : {}),
      ...(params.metadata !== undefined ? { MPTokenMetadata: toHex(params.metadata) } : {}),
    };

    const outcome = await submitAndRequireSuccess(client, issuerWallet, tx);
    const meta = outcome.response.result.meta;
    const issuanceId =
      meta && typeof meta !== "string" && "mpt_issuance_id" in meta && typeof meta.mpt_issuance_id === "string"
        ? meta.mpt_issuance_id
        : undefined;
    if (issuanceId === undefined) {
      throw new Error(
        `MPTokenIssuanceCreate succeeded (hash ${outcome.hash}) but the response did not include mpt_issuance_id.`,
      );
    }

    return new MPTIssuer(client, issuerWallet, issuanceId);
  }

  /** Binds a controller to an issuance that was already created (e.g. in a previous run). */
  static forExistingIssuance(client: Client, issuerWallet: Wallet, issuanceId: string): MPTIssuer {
    return new MPTIssuer(client, issuerWallet, issuanceId);
  }

  // ---------------------------------------------------------------------
  // Allowlist (KYC gate)
  // ---------------------------------------------------------------------

  /**
   * Approves a holder who has already opted in (submitted their own
   * MPTokenAuthorize) so they can hold and receive the token. This is the
   * KYC-approval step.
   */
  async approveHolder(holderAddress: string): Promise<SubmitOutcome> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
    };
    return submitAndRequireSuccess(this.client, this.issuerWallet, tx);
  }

  /**
   * Revokes a holder's allowlist approval without touching their balance.
   * After this, the holder can no longer send or receive the token until
   * re-approved. Used internally by `ban`, but also useful standalone (e.g.
   * a KYC approval that expired).
   */
  async revokeApproval(holderAddress: string): Promise<SubmitOutcome> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    };
    return submitAndRequireSuccess(this.client, this.issuerWallet, tx);
  }

  // ---------------------------------------------------------------------
  // Issuance (minting via Payment from the issuer)
  // ---------------------------------------------------------------------

  /**
   * Sends (mints) `value` units of the token from the issuer to an approved
   * holder.
   *
   * The XRPL protocol's per-holder/global lock only restricts the holder's
   * *own* outgoing transfers -- it does not stop the issuer from unilaterally
   * minting new tokens to a locked holder (the issuer is always privileged,
   * the same way it is exempt from its own trust-line freezes). Since our
   * compliance contract is "a frozen holder can't send OR receive", this
   * method enforces the "receive" half itself, in addition to whatever the
   * allowlist check already gets for free from the protocol (`tecNO_AUTH`).
   */
  async send(toAddress: string, value: string): Promise<SubmitOutcome> {
    const [issuance, holder] = await Promise.all([this.getIssuance(), this.getHolder(toAddress)]);
    if (issuance.globallyLocked) {
      throw new Error(`Refusing to send: issuance ${this.issuanceId} is globally frozen.`);
    }
    if (!holder.exists) {
      throw new Error(`Refusing to send to ${toAddress}: holder has not opted in (no MPToken object).`);
    }
    if (!holder.authorized) {
      throw new Error(`Refusing to send to ${toAddress}: holder is not on the allowlist.`);
    }
    if (holder.locked) {
      throw new Error(`Refusing to send to ${toAddress}: holder is frozen.`);
    }

    const tx: Payment = {
      TransactionType: "Payment",
      Account: this.issuerWallet.address,
      Destination: toAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value },
    };
    return submitAndRequireSuccess(this.client, this.issuerWallet, tx);
  }

  // ---------------------------------------------------------------------
  // Clawback
  // ---------------------------------------------------------------------

  /**
   * Claws back `value` units from a holder. If `value` is omitted, claws
   * back the holder's entire current balance. No-op (does not submit a
   * transaction) if the holder's balance is already zero.
   */
  async clawback(holderAddress: string, value?: string): Promise<SubmitOutcome | undefined> {
    const amountToClaw = value ?? (await this.getHolder(holderAddress)).balance;
    if (amountToClaw === "0") {
      return undefined;
    }

    const tx: Clawback = {
      TransactionType: "Clawback",
      Account: this.issuerWallet.address,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value: amountToClaw },
    };
    return submitAndRequireSuccess(this.client, this.issuerWallet, tx);
  }

  // ---------------------------------------------------------------------
  // Bans
  // ---------------------------------------------------------------------

  /**
   * Bans a holder: claws back their entire balance and revokes their
   * allowlist approval, so they end up holding none of the token and
   * cannot receive it again without a fresh approval from the issuer.
   */
  async ban(holderAddress: string): Promise<void> {
    await this.clawback(holderAddress);
    await this.revokeApproval(holderAddress);
  }

  // ---------------------------------------------------------------------
  // Per-holder freeze
  // ---------------------------------------------------------------------

  async freezeHolder(holderAddress: string): Promise<SubmitOutcome> {
    return this.setLockFlag(MPTokenIssuanceSetFlags.tfMPTLock, holderAddress);
  }

  async unfreezeHolder(holderAddress: string): Promise<SubmitOutcome> {
    return this.setLockFlag(MPTokenIssuanceSetFlags.tfMPTUnlock, holderAddress);
  }

  // ---------------------------------------------------------------------
  // Global freeze
  // ---------------------------------------------------------------------

  async freezeGlobal(): Promise<SubmitOutcome> {
    return this.setLockFlag(MPTokenIssuanceSetFlags.tfMPTLock);
  }

  async unfreezeGlobal(): Promise<SubmitOutcome> {
    return this.setLockFlag(MPTokenIssuanceSetFlags.tfMPTUnlock);
  }

  private async setLockFlag(flag: MPTokenIssuanceSetFlags.tfMPTLock | MPTokenIssuanceSetFlags.tfMPTUnlock, holderAddress?: string): Promise<SubmitOutcome> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: flag,
      ...(holderAddress !== undefined ? { Holder: holderAddress } : {}),
    };
    return submitAndRequireSuccess(this.client, this.issuerWallet, tx);
  }

  // ---------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------

  async getIssuance(): Promise<IssuanceState> {
    return getIssuanceState(this.client, this.issuanceId);
  }

  async getHolder(holderAddress: string): Promise<HolderState> {
    return getHolderState(this.client, this.issuanceId, holderAddress);
  }
}
