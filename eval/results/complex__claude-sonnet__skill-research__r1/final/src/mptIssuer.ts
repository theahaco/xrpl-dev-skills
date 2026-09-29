import {
  Client,
  Wallet,
  LedgerEntry,
  RippledError,
  encodeMPTokenMetadata,
  isValidClassicAddress,
} from "xrpl";
import type {
  SubmittableTransaction,
  TxResponse,
  Payment,
  Clawback,
  MPTokenIssuanceCreate,
  MPTokenIssuanceCreateFlagsInterface,
  MPTokenIssuanceSet,
  MPTokenIssuanceSetFlagsInterface,
  MPTokenAuthorize,
  MPTokenMetadata,
} from "xrpl";

// Holder-side MPToken ledger entry flags (xrpl.js does not export named
// constants for these, only for the issuance side, so they're defined here).
const MPTOKEN_LOCKED_FLAG = 0x00000001;
const MPTOKEN_AUTHORIZED_FLAG = 0x00000002;

// Issuance-side ledger entry flags, mirrored from LedgerEntry.MPTokenIssuanceFlags
// for use as plain numbers when reading raw `Flags` off ledger_entry responses.
const MPTISSUANCE_LOCKED_FLAG = 0x00000001;

export class MptIssuerError extends Error {
  constructor(
    message: string,
    public readonly engineResult?: string,
    public readonly txHash?: string,
  ) {
    super(message);
    this.name = "MptIssuerError";
  }
}

export interface CreateIssuanceParams {
  /** Number of decimal places human-readable amounts are scaled by. Default 2 (cent precision). */
  assetScale?: number;
  /** Maximum supply, expressed in human-readable (decimal) units. Default "1000000000". */
  maximumAmount?: string;
  /** Transfer fee in tenths of a basis point (0-50000). Requires holder-to-holder transfer to be enabled. */
  transferFee?: number;
  /** XLS-89 metadata describing the token. */
  metadata?: MPTokenMetadata;
}

export interface HolderState {
  /** Human-readable balance (already divided by 10^AssetScale). */
  balance: string;
  authorized: boolean;
  frozen: boolean;
}

/**
 * Issuer-side controls for a regulated, stablecoin-style token built on XRPL
 * Multi-Purpose Tokens (MPTs): allowlisting, clawback, per-holder and global
 * freeze, and bans (clawback + deauthorize + lock).
 *
 * One instance manages exactly one MPT issuance. Create it with `createIssuance`,
 * or attach to an existing issuance by passing `issuanceId` to the constructor.
 */
export class MptIssuer {
  private issuanceId: string | undefined;
  private assetScale: number;

  constructor(
    private readonly client: Client,
    private readonly issuerWallet: Wallet,
    options: { issuanceId?: string; assetScale?: number } = {},
  ) {
    this.issuanceId = options.issuanceId;
    this.assetScale = options.assetScale ?? 2;
  }

  get id(): string {
    return this.requireIssuanceId();
  }

  get issuer(): string {
    return this.issuerWallet.address;
  }

  // ---------------------------------------------------------------------
  // Issuance lifecycle
  // ---------------------------------------------------------------------

  /** Creates the MPT issuance with allowlist, clawback, and lock (freeze) capability enabled. */
  async createIssuance(
    params: CreateIssuanceParams = {},
  ): Promise<{ issuanceId: string; hash: string }> {
    if (this.issuanceId !== undefined) {
      throw new MptIssuerError(
        "This MptIssuer instance already manages an issuance; construct a new instance to create another.",
      );
    }

    this.assetScale = params.assetScale ?? this.assetScale;

    const flags: MPTokenIssuanceCreateFlagsInterface = {
      tfMPTRequireAuth: true, // allowlist: holders must be authorized before they can hold the token
      tfMPTCanLock: true, // enables per-holder and global freeze
      tfMPTCanClawback: true, // enables clawback
      tfMPTCanTransfer: true, // allow holder-to-holder transfers, not just issuer<->holder
    };

    const tx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: this.issuerWallet.address,
      AssetScale: this.assetScale,
      MaximumAmount: humanToBaseUnits(
        params.maximumAmount ?? "1000000000",
        this.assetScale,
      ),
      Flags: flags,
      ...(params.transferFee !== undefined
        ? { TransferFee: params.transferFee }
        : {}),
      ...(params.metadata !== undefined
        ? { MPTokenMetadata: encodeMPTokenMetadata(params.metadata) }
        : {}),
    };

    const response = await this.submit(tx);
    const meta = response.result.meta;
    if (meta === undefined || typeof meta === "string") {
      throw new MptIssuerError(
        "MPTokenIssuanceCreate succeeded but returned no transaction metadata",
        undefined,
        response.result.hash,
      );
    }
    const issuanceId = meta.mpt_issuance_id;
    if (issuanceId === undefined) {
      throw new MptIssuerError(
        "MPTokenIssuanceCreate succeeded but no mpt_issuance_id was found in its metadata",
        undefined,
        response.result.hash,
      );
    }

    this.issuanceId = issuanceId;
    return { issuanceId, hash: response.result.hash };
  }

  // ---------------------------------------------------------------------
  // Allowlist (KYC gate)
  // ---------------------------------------------------------------------

  /**
   * Holder-side opt-in: creates the holder's MPToken entry. A real deployment
   * has each holder (or their custodial wallet) submit this themselves; it's
   * exposed here as a convenience for backends that manage holder keys directly.
   */
  async optInHolder(holderWallet: Wallet): Promise<TxResponse<MPTokenAuthorize>> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: holderWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
    };
    return this.submit(tx, holderWallet);
  }

  /** Issuer-side allowlisting: authorizes a holder (who must already hold an MPToken entry) to hold the token. */
  async approveHolder(holderAddress: string): Promise<TxResponse<MPTokenAuthorize>> {
    assertValidAddress(holderAddress);
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
      Holder: holderAddress,
    };
    return this.submit(tx);
  }

  /** Removes a holder's allowlist authorization without touching their balance or lock state. */
  async revokeHolderApproval(
    holderAddress: string,
  ): Promise<TxResponse<MPTokenAuthorize>> {
    assertValidAddress(holderAddress);
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    };
    return this.submit(tx);
  }

  // ---------------------------------------------------------------------
  // Transfers
  // ---------------------------------------------------------------------

  /** Issues (sends) `amount` (human-readable units) from the issuer to an approved holder. */
  async sendTokens(
    destination: string,
    amount: string,
  ): Promise<TxResponse<Payment>> {
    assertValidAddress(destination);
    const tx: Payment = {
      TransactionType: "Payment",
      Account: this.issuerWallet.address,
      Destination: destination,
      Amount: {
        mpt_issuance_id: this.requireIssuanceId(),
        value: humanToBaseUnits(amount, this.assetScale),
      },
    };
    return this.submit(tx);
  }

  // ---------------------------------------------------------------------
  // Clawback
  // ---------------------------------------------------------------------

  /** Claws back `amount` (human-readable units) of the token from a holder's balance. */
  async clawback(
    holderAddress: string,
    amount: string,
  ): Promise<TxResponse<Clawback>> {
    assertValidAddress(holderAddress);
    const tx: Clawback = {
      TransactionType: "Clawback",
      Account: this.issuerWallet.address,
      Holder: holderAddress,
      Amount: {
        mpt_issuance_id: this.requireIssuanceId(),
        value: humanToBaseUnits(amount, this.assetScale),
      },
    };
    return this.submit(tx);
  }

  // ---------------------------------------------------------------------
  // Freeze (per-holder and global)
  // ---------------------------------------------------------------------

  /** Freezes a single holder: they can no longer send or receive the token. */
  async freezeHolder(
    holderAddress: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    assertValidAddress(holderAddress);
    return this.setLock(true, holderAddress);
  }

  /** Lifts a per-holder freeze. */
  async unfreezeHolder(
    holderAddress: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    assertValidAddress(holderAddress);
    return this.setLock(false, holderAddress);
  }

  /** Freezes all movement of the token, for every holder, e.g. during an incident. */
  async freezeGlobal(): Promise<TxResponse<MPTokenIssuanceSet>> {
    return this.setLock(true);
  }

  /** Lifts a global freeze. */
  async unfreezeGlobal(): Promise<TxResponse<MPTokenIssuanceSet>> {
    return this.setLock(false);
  }

  private async setLock(
    lock: boolean,
    holderAddress?: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    const flags: MPTokenIssuanceSetFlagsInterface = lock
      ? { tfMPTLock: true }
      : { tfMPTUnlock: true };
    const tx: MPTokenIssuanceSet = {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
      Flags: flags,
      ...(holderAddress !== undefined ? { Holder: holderAddress } : {}),
    };
    return this.submit(tx);
  }

  // ---------------------------------------------------------------------
  // Bans
  // ---------------------------------------------------------------------

  /**
   * Bans a holder: claws back their entire balance, freezes their holding,
   * and revokes their allowlist authorization, so they end up holding none
   * of the token and cannot be paid again while RequireAuth is enforced.
   */
  async banHolder(holderAddress: string): Promise<{ clawedBack: string }> {
    assertValidAddress(holderAddress);
    const state = await this.getHolderState(holderAddress);
    let clawedBack = "0";
    if (state !== undefined && state.balance !== "0") {
      clawedBack = state.balance;
      await this.clawback(holderAddress, state.balance);
    }
    await this.freezeHolder(holderAddress);
    await this.revokeHolderApproval(holderAddress);
    return { clawedBack };
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  /** Reads the MPTokenIssuance ledger entry, or undefined if it no longer exists. */
  async getIssuanceEntry(): Promise<LedgerEntry.MPTokenIssuance | undefined> {
    try {
      const resp = await this.client.request({
        command: "ledger_entry",
        mpt_issuance: this.requireIssuanceId(),
        ledger_index: "validated",
      });
      return resp.result.node as unknown as LedgerEntry.MPTokenIssuance;
    } catch (err) {
      if (isEntryNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Reads a holder's MPToken ledger entry, or undefined if they have no entry (never opted in, or opted out). */
  async getHolderEntry(
    holderAddress: string,
  ): Promise<LedgerEntry.MPToken | undefined> {
    assertValidAddress(holderAddress);
    try {
      const resp = await this.client.request({
        command: "ledger_entry",
        mptoken: {
          mpt_issuance_id: this.requireIssuanceId(),
          account: holderAddress,
        },
        ledger_index: "validated",
      });
      return resp.result.node as unknown as LedgerEntry.MPToken;
    } catch (err) {
      if (isEntryNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Convenience summary of a holder's balance, authorization, and freeze status, in human-readable units. */
  async getHolderState(holderAddress: string): Promise<HolderState | undefined> {
    const entry = await this.getHolderEntry(holderAddress);
    if (entry === undefined) return undefined;
    return {
      balance: baseUnitsToHuman(entry.MPTAmount, this.assetScale),
      authorized: (entry.Flags & MPTOKEN_AUTHORIZED_FLAG) !== 0,
      frozen: (entry.Flags & MPTOKEN_LOCKED_FLAG) !== 0,
    };
  }

  /** Whether the whole issuance is currently globally frozen. */
  async isGloballyFrozen(): Promise<boolean> {
    const issuance = await this.getIssuanceEntry();
    if (issuance === undefined) {
      throw new MptIssuerError("MPT issuance not found on ledger");
    }
    return (issuance.Flags & MPTISSUANCE_LOCKED_FLAG) !== 0;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private requireIssuanceId(): string {
    if (this.issuanceId === undefined) {
      throw new MptIssuerError(
        "No MPT issuance is associated with this MptIssuer; call createIssuance() first.",
      );
    }
    return this.issuanceId;
  }

  private async submit<T extends SubmittableTransaction>(
    tx: T,
    wallet: Wallet = this.issuerWallet,
  ): Promise<TxResponse<T>> {
    const response = await this.client.submitAndWait(tx, {
      autofill: true,
      wallet,
    });
    const { meta, hash, validated } = response.result;
    if (validated !== true) {
      throw new MptIssuerError(
        `${tx.TransactionType} was not validated`,
        undefined,
        hash,
      );
    }
    if (meta === undefined || typeof meta === "string") {
      throw new MptIssuerError(
        `${tx.TransactionType} returned no transaction metadata`,
        undefined,
        hash,
      );
    }
    if (meta.TransactionResult !== "tesSUCCESS") {
      throw new MptIssuerError(
        `${tx.TransactionType} failed with ${meta.TransactionResult}`,
        meta.TransactionResult,
        hash,
      );
    }
    return response;
  }
}

function isEntryNotFound(err: unknown): boolean {
  return (
    err instanceof RippledError &&
    typeof err.data === "object" &&
    err.data !== null &&
    (err.data as { error?: string }).error === "entryNotFound"
  );
}

function assertValidAddress(address: string): void {
  if (!isValidClassicAddress(address)) {
    throw new MptIssuerError(`"${address}" is not a valid XRPL classic address`);
  }
}

/** Converts a human-readable decimal string (e.g. "500.25") into the raw integer base-unit string MPT amounts use on the wire. */
export function humanToBaseUnits(value: string, assetScale: number): string {
  if (!/^\d+(\.\d+)?$/u.test(value)) {
    throw new MptIssuerError(`"${value}" is not a valid non-negative decimal amount`);
  }
  const [whole = "0", frac = ""] = value.split(".");
  if (frac.length > assetScale) {
    throw new MptIssuerError(
      `"${value}" has more decimal places than the asset scale (${assetScale}) allows`,
    );
  }
  const combined = whole + frac.padEnd(assetScale, "0");
  const normalized = combined.replace(/^0+(?=\d)/u, "");
  return normalized;
}

/** Converts a raw integer base-unit string back into a human-readable decimal string. */
export function baseUnitsToHuman(units: string, assetScale: number): string {
  if (assetScale === 0) return units;
  const padded = units.padStart(assetScale + 1, "0");
  const whole = padded.slice(0, -assetScale);
  const frac = padded.slice(-assetScale).replace(/0+$/u, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}
