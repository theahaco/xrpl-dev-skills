/**
 * Issuer-side module for a regulated, stablecoin-style token on the XRP Ledger,
 * built on Multi-Purpose Tokens (MPTs, XLS-33).
 *
 * Wraps the MPT transaction family (MPTokenIssuanceCreate, MPTokenIssuanceSet,
 * MPTokenAuthorize, Clawback, Payment) with the compliance operations a
 * regulated issuer needs: allowlisting, clawback, per-holder freeze, global
 * freeze, and address bans. Every mutating call submits a transaction, waits
 * for validation, and throws if the ledger did not apply it.
 */

import { RippledError } from "xrpl";
import type { Client, LedgerEntry, TxResponse, Wallet } from "xrpl";
import type {
  Clawback,
  MPTokenAuthorize,
  MPTokenIssuanceCreate,
  MPTokenIssuanceSet,
  Payment,
  SubmittableTransaction,
} from "xrpl";

type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;

/** Parameters accepted by {@link MptIssuer.createIssuance}. */
export interface IssuanceConfig {
  /** Decimal places the token can be subdivided into (0-255). Defaults to 2 (cents-like precision). */
  assetScale?: number;
  /** Hard cap on total outstanding supply, in the smallest unit. Defaults to no explicit cap (ledger max). */
  maximumAmount?: string;
  /** Secondary-sale transfer fee, in increments of 0.001% (0-50000). Requires holder-to-holder transfer to be enabled. */
  transferFee?: number;
  /** Metadata already hex-encoded (e.g. a JSON document per XLS-89), stored on the issuance, up to 1024 bytes. */
  metadataHex?: string;
  /** Allow holder-to-holder transfers, not just issuer<->holder. Defaults to true. */
  canTransfer?: boolean;
}

/** Point-in-time compliance state of a single holder for this issuance. */
export interface HolderStatus {
  /** Whether the holder has an MPToken object at all (i.e. has opted in). */
  exists: boolean;
  /** Whether the issuer has authorized this holder to hold the token (allowlist). */
  authorized: boolean;
  /** Whether the issuer has individually frozen (locked) this holder's balance. */
  frozen: boolean;
  /** Current balance, in the smallest unit, as a decimal string. */
  balance: string;
}

/** Point-in-time compliance state of the issuance as a whole. */
export interface IssuanceStatus {
  issuanceId: string;
  issuer: string;
  outstandingAmount: string;
  /** Whether all movement of the token is currently frozen (global freeze / lock). */
  globallyLocked: boolean;
  requireAuth: boolean;
  canClawback: boolean;
  canLock: boolean;
  canTransfer: boolean;
}

const LSF_MPTOKEN_LOCKED = 0x00000001;
const LSF_MPTOKEN_AUTHORIZED = 0x00000002;

const LSF_ISSUANCE_LOCKED = 0x00000001;
const LSF_ISSUANCE_CAN_LOCK = 0x00000002;
const LSF_ISSUANCE_REQUIRE_AUTH = 0x00000004;
const LSF_ISSUANCE_CAN_TRANSFER = 0x00000020;
const LSF_ISSUANCE_CAN_CLAWBACK = 0x00000040;

/** Thrown when a submitted transaction is not applied successfully (i.e. does not reach `tesSUCCESS`). */
export class MptTransactionError extends Error {
  constructor(
    public readonly transactionType: string,
    public readonly transactionResult: string,
    public readonly txHash?: string,
  ) {
    super(
      `${transactionType} failed with ${transactionResult}${txHash ? ` (tx ${txHash})` : ""}`,
    );
    this.name = "MptTransactionError";
  }
}

/**
 * Thrown when {@link MptIssuer.pay} is refused by an application-level compliance
 * check, before any transaction is submitted to the ledger.
 *
 * The MPT "lock" primitive (both per-holder and global) only blocks *peer-to-peer*
 * movement on-ledger: rippled still permits direct issuer<->holder payments even
 * while a holder or the whole issuance is locked (this mirrors legacy trust-line
 * freeze behavior, and was confirmed empirically against testnet). A locked holder
 * that "can't send or receive" and a global freeze that blocks "all movement" are
 * therefore compliance guarantees this module enforces in application code, on top
 * of the ledger-level protection for peer-to-peer transfers.
 */
export class MptComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MptComplianceError";
  }
}

export class MptIssuer {
  /** The MPT issuance this instance operates on, once created or attached. */
  public issuanceId: string | undefined;

  /**
   * @param client Connected (or connectable) xrpl.js Client. Lifecycle (connect/disconnect) is the caller's responsibility.
   * @param issuerWallet Wallet for the issuing account. Every issuer-signed transaction uses this wallet.
   * @param issuanceId Optional: attach to an issuance that already exists, instead of calling {@link createIssuance}.
   */
  constructor(
    private readonly client: Client,
    private readonly issuerWallet: Wallet,
    issuanceId?: string,
  ) {
    this.issuanceId = issuanceId;
  }

  /** The issuer's classic address. */
  get issuerAddress(): string {
    return this.issuerWallet.address;
  }

  // ---------------------------------------------------------------------
  // Issuance lifecycle
  // ---------------------------------------------------------------------

  /**
   * Creates the MPT issuance with every compliance control this module supports
   * enabled: allowlist (RequireAuth), per-holder/global freeze (CanLock), and
   * clawback (CanClawback). Sets {@link issuanceId} on success.
   */
  async createIssuance(config: IssuanceConfig = {}): Promise<string> {
    const canTransfer = config.canTransfer ?? true;

    const tx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: this.issuerWallet.address,
      AssetScale: config.assetScale ?? 2,
      Flags: {
        tfMPTCanLock: true,
        tfMPTRequireAuth: true,
        tfMPTCanClawback: true,
        tfMPTCanTransfer: canTransfer,
      },
      ...(config.maximumAmount !== undefined && { MaximumAmount: config.maximumAmount }),
      ...(config.transferFee !== undefined && { TransferFee: config.transferFee }),
      ...(config.metadataHex !== undefined && { MPTokenMetadata: config.metadataHex }),
    };

    const response = await this.submit(tx);
    const meta = response.result.meta;
    if (!meta || typeof meta === "string" || !meta.mpt_issuance_id) {
      throw new Error(
        "MPTokenIssuanceCreate succeeded but the ledger did not return an mpt_issuance_id",
      );
    }
    this.issuanceId = meta.mpt_issuance_id;
    return this.issuanceId;
  }

  // ---------------------------------------------------------------------
  // Allowlist (KYC gating)
  // ---------------------------------------------------------------------

  /**
   * Holder-side opt-in: creates the holder's MPToken object. Must happen before
   * the issuer can authorize the holder, and before the holder can receive any
   * balance. Call with the holder's own wallet.
   */
  async optIn(holderWallet: Wallet): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: holderWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
    };
    await this.submit(tx, holderWallet);
  }

  /**
   * Issuer-side allowlist grant: authorizes a holder (who must have already
   * opted in via {@link optIn}) to hold and receive this token. This is the
   * "approved after KYC" step.
   */
  async approveHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
      Holder: holderAddress,
    };
    await this.submit(tx);
  }

  /**
   * Issuer-side allowlist revocation: removes a holder's authorization so they
   * can no longer receive this token. Does not touch their balance or send-side
   * ability to return tokens to the issuer. Used internally by {@link ban};
   * exposed directly for revoking approval without a full ban.
   */
  async revokeHolderApproval(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    };
    await this.submit(tx);
  }

  // ---------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------

  /**
   * Sends `value` (in the smallest unit, as a decimal string) of this MPT from
   * `fromWallet` to `toAddress`. Refused with {@link MptComplianceError}, before
   * touching the ledger, if the issuance is globally frozen or if either party
   * is individually frozen — see that class's docs for why this check lives here
   * rather than relying on the ledger alone.
   */
  async pay(fromWallet: Wallet, toAddress: string, value: string): Promise<void> {
    await this.assertMovementAllowed(fromWallet.address, toAddress);
    const tx: Payment = {
      TransactionType: "Payment",
      Account: fromWallet.address,
      Destination: toAddress,
      Amount: { mpt_issuance_id: this.requireIssuanceId(), value },
    };
    await this.submit(tx, fromWallet);
  }

  private async assertMovementAllowed(fromAddress: string, toAddress: string): Promise<void> {
    const issuance = await this.getIssuanceStatus();
    if (issuance.globallyLocked) {
      throw new MptComplianceError(
        `Cannot complete payment: MPT issuance ${issuance.issuanceId} is globally frozen`,
      );
    }
    for (const [address, role] of [
      [fromAddress, "sender"],
      [toAddress, "recipient"],
    ] as const) {
      if (address === this.issuerWallet.address) {
        continue;
      }
      const status = await this.getHolderStatus(address);
      if (status.frozen) {
        throw new MptComplianceError(`Cannot complete payment: ${role} ${address} is frozen`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Freeze controls
  // ---------------------------------------------------------------------

  /** Freezes a single holder: they can neither send nor receive this token until unfrozen. */
  async freezeHolder(holderAddress: string): Promise<void> {
    await this.setIssuance({ Holder: holderAddress, Flags: { tfMPTLock: true } });
  }

  /** Lifts an individual holder freeze. */
  async unfreezeHolder(holderAddress: string): Promise<void> {
    await this.setIssuance({ Holder: holderAddress, Flags: { tfMPTUnlock: true } });
  }

  /** Freezes all movement of the token, for every holder, e.g. during an incident. */
  async globalFreeze(): Promise<void> {
    await this.setIssuance({ Flags: { tfMPTLock: true } });
  }

  /** Lifts a global freeze. */
  async globalUnfreeze(): Promise<void> {
    await this.setIssuance({ Flags: { tfMPTUnlock: true } });
  }

  private async setIssuance(
    fields: Pick<MPTokenIssuanceSet, "Holder" | "Flags">,
  ): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.requireIssuanceId(),
      ...fields,
    };
    await this.submit(tx);
  }

  // ---------------------------------------------------------------------
  // Clawback
  // ---------------------------------------------------------------------

  /** Claws back exactly `value` (smallest unit, decimal string) of this MPT from `holderAddress`. */
  async clawback(holderAddress: string, value: string): Promise<void> {
    const tx: Clawback = {
      TransactionType: "Clawback",
      Account: this.issuerWallet.address,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: this.requireIssuanceId(), value },
    };
    await this.submit(tx);
  }

  /** Claws back a holder's entire current balance. Returns the amount clawed back. A zero balance is a no-op. */
  async clawbackAll(holderAddress: string): Promise<string> {
    const { balance } = await this.getHolderStatus(holderAddress);
    if (balance === "0") {
      return "0";
    }
    await this.clawback(holderAddress, balance);
    return balance;
  }

  // ---------------------------------------------------------------------
  // Bans
  // ---------------------------------------------------------------------

  /**
   * Bans a holder: claws back their entire balance and revokes their allowlist
   * authorization, so they end up holding none of the token and cannot be paid
   * it again (the issuance requires authorization, and they no longer have it).
   */
  async ban(holderAddress: string): Promise<void> {
    await this.clawbackAll(holderAddress);
    await this.revokeHolderApproval(holderAddress);
  }

  // ---------------------------------------------------------------------
  // Read-only status
  // ---------------------------------------------------------------------

  /** Reads the current compliance state of a single holder for this issuance. */
  async getHolderStatus(holderAddress: string): Promise<HolderStatus> {
    const issuanceId = this.requireIssuanceId();
    let mptoken: MPToken;
    try {
      const response = await this.client.request({
        command: "ledger_entry",
        mptoken: { mpt_issuance_id: issuanceId, account: holderAddress },
        ledger_index: "validated",
      });
      // The installed xrpl typings omit the plain `MPToken` ledger entry from the
      // generic `LedgerEntry` union even though `mptoken` lookups return it;
      // narrow with a cast instead of trusting the declared response type.
      mptoken = response.result.node as unknown as MPToken;
    } catch (err) {
      if (err instanceof RippledError && this.isEntryNotFound(err)) {
        return { exists: false, authorized: false, frozen: false, balance: "0" };
      }
      throw err;
    }

    return {
      exists: true,
      authorized: (mptoken.Flags & LSF_MPTOKEN_AUTHORIZED) !== 0,
      frozen: (mptoken.Flags & LSF_MPTOKEN_LOCKED) !== 0,
      // rippled omits MPTAmount from the ledger entry entirely when the balance is zero.
      balance: mptoken.MPTAmount ?? "0",
    };
  }

  /** Reads the current compliance state of the issuance as a whole. */
  async getIssuanceStatus(): Promise<IssuanceStatus> {
    const issuanceId = this.requireIssuanceId();
    const response = await this.client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const issuance = response.result.node as unknown as MPTokenIssuance;

    return {
      issuanceId,
      issuer: issuance.Issuer,
      outstandingAmount: issuance.OutstandingAmount,
      globallyLocked: (issuance.Flags & LSF_ISSUANCE_LOCKED) !== 0,
      requireAuth: (issuance.Flags & LSF_ISSUANCE_REQUIRE_AUTH) !== 0,
      canClawback: (issuance.Flags & LSF_ISSUANCE_CAN_CLAWBACK) !== 0,
      canLock: (issuance.Flags & LSF_ISSUANCE_CAN_LOCK) !== 0,
      canTransfer: (issuance.Flags & LSF_ISSUANCE_CAN_TRANSFER) !== 0,
    };
  }

  private isEntryNotFound(err: RippledError): boolean {
    const data = err.data as { error?: string } | undefined;
    return data?.error === "entryNotFound";
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private requireIssuanceId(): string {
    if (!this.issuanceId) {
      throw new Error(
        "No MPT issuance is attached to this MptIssuer. Call createIssuance() first, or pass an issuanceId to the constructor.",
      );
    }
    return this.issuanceId;
  }

  private async submit<T extends SubmittableTransaction>(
    tx: T,
    signer: Wallet = this.issuerWallet,
  ): Promise<TxResponse<T>> {
    const response = await this.client.submitAndWait(tx, { wallet: signer, autofill: true });
    const meta = response.result.meta;
    if (!meta || typeof meta === "string") {
      throw new Error(
        `${tx.TransactionType} produced no usable metadata (tx ${response.result.hash})`,
      );
    }
    if (meta.TransactionResult !== "tesSUCCESS") {
      throw new MptTransactionError(tx.TransactionType, meta.TransactionResult, response.result.hash);
    }
    return response;
  }
}
