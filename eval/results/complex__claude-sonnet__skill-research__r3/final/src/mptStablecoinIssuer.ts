import {
  Client,
  Wallet,
  MPTokenIssuanceCreateFlags,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceSetFlags,
  encodeMPTokenMetadata,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type TransactionMetadataBase,
  type Payment,
  type Clawback,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceSet,
  type LedgerEntry,
  type TxResponse,
} from "xrpl";

type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;

/**
 * Thrown when a submitted transaction is validated by the ledger but does not
 * result in `tesSUCCESS` (e.g. a `tec`-class failure such as attempting to
 * pay a banned/unauthorized holder).
 */
export class MPTTransactionError extends Error {
  constructor(
    public readonly transactionType: string,
    public readonly engineResult: string,
    public readonly engineResultMessage: string,
  ) {
    super(
      `${transactionType} failed with ${engineResult}: ${engineResultMessage}`,
    );
    this.name = "MPTTransactionError";
  }
}

export interface CreateIssuanceOptions {
  /** Decimal places for display purposes. `AssetScale: 2` means "100" on the ledger displays as "1.00". Default: 2. */
  assetScale?: number;
  /** Maximum number of smallest-unit tokens that may ever exist. Defaults to the protocol maximum. */
  maximumAmount?: string;
  /** Secondary-sale transfer fee in 1/1000ths of a percent (0-50000). Requires holder-to-holder transfers to be enabled. */
  transferFee?: number;
  /** XLS-89 structured metadata (ticker, name, description, etc.), encoded and stored on the issuance. */
  metadata?: MPTokenMetadata;
  /** Allow direct transfers between two non-issuer holders. Default: true. */
  allowHolderToHolderTransfers?: boolean;
}

export interface HolderState {
  address: string;
  /** Whether the holder has an MPToken object at all (i.e. has opted in). */
  exists: boolean;
  /** Balance in smallest units, as a string to avoid precision loss. */
  balance: string;
  /** Whether the issuer has authorized this holder under allow-listing. */
  authorized: boolean;
  /** Whether this specific holder's balance is locked (frozen). */
  locked: boolean;
}

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  outstandingAmount: string;
  maximumAmount: string;
  assetScale: number;
  transferFee: number;
  requireAuth: boolean;
  canClawback: boolean;
  canLock: boolean;
  canTransfer: boolean;
  /** Whether the entire issuance is globally locked (frozen). */
  globallyLocked: boolean;
}

/**
 * Issuer-side control surface for a regulated MPT (Multi-Purpose Token).
 *
 * Wraps the raw MPTokenIssuanceCreate / MPTokenAuthorize / MPTokenIssuanceSet /
 * Clawback / Payment transactions behind a compliance-oriented API: allowlisting,
 * clawback, bans, per-holder freeze, and global freeze.
 *
 * One instance manages exactly one MPT issuance once `createIssuance` (or
 * `attachToIssuance`) has been called.
 */
export class MPTStablecoinIssuer {
  private issuanceId: string | undefined;

  constructor(
    private readonly client: Client,
    private readonly issuer: Wallet,
  ) {}

  /** The issuer's classic XRPL address. */
  get issuerAddress(): string {
    return this.issuer.address;
  }

  /** The MPT issuance ID this instance manages, once known. */
  get currentIssuanceId(): string {
    if (this.issuanceId === undefined) {
      throw new Error(
        "No MPT issuance is attached yet. Call createIssuance() or attachToIssuance() first.",
      );
    }
    return this.issuanceId;
  }

  /** Attach this issuer instance to a pre-existing issuance ID (e.g. across process restarts). */
  attachToIssuance(issuanceId: string): void {
    this.issuanceId = issuanceId;
  }

  /**
   * Creates the MPT issuance with every compliance control enabled:
   * - `tfMPTRequireAuth` (allowlist)
   * - `tfMPTCanLock` (per-holder + global freeze)
   * - `tfMPTCanClawback` (clawback)
   * - `tfMPTCanTransfer` (holder-to-holder transfers), unless disabled
   *
   * Returns the new `MPTokenIssuanceID`.
   */
  async createIssuance(options: CreateIssuanceOptions = {}): Promise<string> {
    const allowTransfer = options.allowHolderToHolderTransfers ?? true;

    // eslint-disable-next-line no-bitwise -- combining MPT transaction flags is idiomatic bitmask usage
    let flags =
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback;
    if (allowTransfer) {
      // eslint-disable-next-line no-bitwise -- see above
      flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
    }

    const tx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: this.issuer.address,
      AssetScale: options.assetScale ?? 2,
      Flags: flags,
      ...(options.maximumAmount !== undefined && {
        MaximumAmount: options.maximumAmount,
      }),
      ...(options.transferFee !== undefined && {
        TransferFee: options.transferFee,
      }),
      ...(options.metadata !== undefined && {
        MPTokenMetadata: encodeMPTokenMetadata(options.metadata),
      }),
    };

    const response = await this.submit(this.issuer, tx);
    const meta = response.result.meta as
      | (TransactionMetadataBase & { mpt_issuance_id?: string })
      | undefined;
    const issuanceId = meta?.mpt_issuance_id;
    if (issuanceId === undefined) {
      throw new Error(
        "MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned in the transaction metadata.",
      );
    }

    this.issuanceId = issuanceId;
    return issuanceId;
  }

  /**
   * Approves a holder (post-KYC): the holder opts in, then the issuer
   * allow-lists them. Both steps are required because the issuance was
   * created with `tfMPTRequireAuth`.
   */
  async approveHolder(holder: Wallet): Promise<void> {
    const issuanceId = this.currentIssuanceId;

    const optIn: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: holder.address,
      MPTokenIssuanceID: issuanceId,
    };
    await this.submit(holder, optIn);

    const authorize: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuer.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.address,
    };
    await this.submit(this.issuer, authorize);
  }

  /**
   * Revokes a holder's allow-list authorization, without affecting their
   * balance. After this, the holder can neither send nor receive the token.
   * Used internally by `banHolder`, but exposed for cases where a holder
   * should be de-authorized without a full ban.
   */
  async revokeAuthorization(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuer.address,
      MPTokenIssuanceID: this.currentIssuanceId,
      Holder: holderAddress,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    };
    await this.submit(this.issuer, tx);
  }

  /** Sends newly issued tokens from the issuer to an approved holder. */
  async sendTokens(destination: string, value: string): Promise<void> {
    const tx: Payment = {
      TransactionType: "Payment",
      Account: this.issuer.address,
      Destination: destination,
      Amount: {
        mpt_issuance_id: this.currentIssuanceId,
        value,
      },
    };
    await this.submit(this.issuer, tx);
  }

  /** Claws back an exact amount of the token from a holder, back to the issuer. */
  async clawback(holderAddress: string, value: string): Promise<void> {
    const tx: Clawback = {
      TransactionType: "Clawback",
      Account: this.issuer.address,
      Holder: holderAddress,
      Amount: {
        mpt_issuance_id: this.currentIssuanceId,
        value,
      },
    };
    await this.submit(this.issuer, tx);
  }

  /** Freezes a single holder: they can no longer send or receive the token. */
  async freezeHolder(holderAddress: string): Promise<void> {
    await this.setLock(holderAddress, true);
  }

  /** Lifts a per-holder freeze. */
  async unfreezeHolder(holderAddress: string): Promise<void> {
    await this.setLock(holderAddress, false);
  }

  /** Freezes movement of the token for every holder (e.g. during an incident). */
  async globalFreeze(): Promise<void> {
    await this.setLock(undefined, true);
  }

  /** Lifts a global freeze. */
  async globalUnfreeze(): Promise<void> {
    await this.setLock(undefined, false);
  }

  /**
   * Bans a holder permanently: claws back their entire balance (if any) and
   * then revokes their allow-list authorization, so they end up holding none
   * of the token and cannot be paid it again (future Payments/authorizations
   * to them fail because the issuance requires auth and they are no longer
   * authorized).
   */
  async banHolder(holderAddress: string): Promise<void> {
    const holder = await this.getHolderState(holderAddress);
    if (holder.exists && BigInt(holder.balance) > 0n) {
      await this.clawback(holderAddress, holder.balance);
    }
    await this.revokeAuthorization(holderAddress);
  }

  /** Reads the current state of a holder's MPToken object, if any. */
  async getHolderState(holderAddress: string): Promise<HolderState> {
    const issuanceId = this.currentIssuanceId;
    try {
      const response = await this.client.request({
        command: "ledger_entry",
        mptoken: {
          mpt_issuance_id: issuanceId,
          account: holderAddress,
        },
      });
      const node = response.result.node as unknown as MPToken;
      return {
        address: holderAddress,
        exists: true,
        balance: node.MPTAmount ?? "0",
        // eslint-disable-next-line no-bitwise -- reading a ledger flag bit
        authorized: (node.Flags & MPTOKEN_LSF_AUTHORIZED) !== 0,
        // eslint-disable-next-line no-bitwise -- reading a ledger flag bit
        locked: (node.Flags & MPTOKEN_LSF_LOCKED) !== 0,
      };
    } catch (error) {
      if (isEntryNotFoundError(error)) {
        return {
          address: holderAddress,
          exists: false,
          balance: "0",
          authorized: false,
          locked: false,
        };
      }
      throw error;
    }
  }

  /** Reads the current state of the MPT issuance itself. */
  async getIssuanceState(): Promise<IssuanceState> {
    const issuanceId = this.currentIssuanceId;
    const response = await this.client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
    });
    const node = response.result.node as unknown as MPTokenIssuance;
    const flags = node.Flags;
    return {
      issuanceId,
      issuer: node.Issuer,
      outstandingAmount: node.OutstandingAmount ?? "0",
      maximumAmount: node.MaximumAmount ?? "0",
      assetScale: node.AssetScale ?? 0,
      transferFee: node.TransferFee ?? 0,
      // eslint-disable-next-line no-bitwise -- reading ledger flag bits
      requireAuth: (flags & MPTOKEN_ISSUANCE_LSF_REQUIRE_AUTH) !== 0,
      // eslint-disable-next-line no-bitwise -- reading ledger flag bits
      canClawback: (flags & MPTOKEN_ISSUANCE_LSF_CAN_CLAWBACK) !== 0,
      // eslint-disable-next-line no-bitwise -- reading ledger flag bits
      canLock: (flags & MPTOKEN_ISSUANCE_LSF_CAN_LOCK) !== 0,
      // eslint-disable-next-line no-bitwise -- reading ledger flag bits
      canTransfer: (flags & MPTOKEN_ISSUANCE_LSF_CAN_TRANSFER) !== 0,
      // eslint-disable-next-line no-bitwise -- reading ledger flag bits
      globallyLocked: (flags & MPTOKEN_ISSUANCE_LSF_LOCKED) !== 0,
    };
  }

  private async setLock(
    holderAddress: string | undefined,
    lock: boolean,
  ): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuer.address,
      MPTokenIssuanceID: this.currentIssuanceId,
      ...(holderAddress !== undefined && { Holder: holderAddress }),
      Flags: lock
        ? MPTokenIssuanceSetFlags.tfMPTLock
        : MPTokenIssuanceSetFlags.tfMPTUnlock,
    };
    await this.submit(this.issuer, tx);
  }

  private async submit<T extends SubmittableTransaction>(
    wallet: Wallet,
    transaction: T,
  ): Promise<TxResponse<T>> {
    const response = await this.client.submitAndWait(transaction, {
      autofill: true,
      wallet,
    });

    const meta = response.result.meta;
    if (meta === undefined || typeof meta === "string") {
      throw new Error(
        `${transaction.TransactionType} did not return transaction metadata; cannot confirm result.`,
      );
    }
    const result = (meta as TransactionMetadataBase).TransactionResult;
    if (result !== "tesSUCCESS") {
      throw new MPTTransactionError(
        transaction.TransactionType,
        result,
        `See https://xrpl.org/docs/references/protocol/transactions/transaction-results for details on ${result}.`,
      );
    }
    return response;
  }
}

// MPToken (per-holder) ledger entry flags. Not exported as an enum by xrpl.js,
// so the bit values from the MPToken ledger object spec are inlined here.
const MPTOKEN_LSF_LOCKED = 0x00000001;
const MPTOKEN_LSF_AUTHORIZED = 0x00000002;

// MPTokenIssuance ledger entry flags (mirrors MPTokenIssuanceCreateFlags bit values).
const MPTOKEN_ISSUANCE_LSF_LOCKED = 0x00000001;
const MPTOKEN_ISSUANCE_LSF_CAN_LOCK = 0x00000002;
const MPTOKEN_ISSUANCE_LSF_REQUIRE_AUTH = 0x00000004;
const MPTOKEN_ISSUANCE_LSF_CAN_TRANSFER = 0x00000020;
const MPTOKEN_ISSUANCE_LSF_CAN_CLAWBACK = 0x00000040;

function isEntryNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof (error as { data?: unknown }).data === "object" &&
    (error as { data?: { error?: unknown } }).data?.error === "entryNotFound"
  );
}
