import {
  encodeMPTokenMetadata,
  LedgerEntry,
  parseMPTokenIssuanceFlags,
} from "xrpl";
import type {
  Client,
  Clawback,
  MPTokenAuthorize,
  MPTokenIssuanceCreate,
  MPTokenIssuanceSet,
  MPTokenMetadata,
  Payment,
  Wallet,
} from "xrpl";

import { isEntryNotFoundError, submitAndAssertSuccess } from "./txSubmit";

/**
 * The MPToken ledger object's own flags (distinct from MPTokenIssuance
 * flags). xrpl.js does not export an enum for these, so they're pinned here
 * against the xrpl.org "MPToken" ledger object reference.
 */
const MPTOKEN_LEDGER_FLAGS = {
  lsfMPTLocked: 0x00000001,
  lsfMPTAuthorized: 0x00000002,
} as const;

export interface CreateIssuanceOptions {
  /** Uppercase ticker, A-Z0-9, max 6 chars (XLS-89 MPTokenMetadata). */
  ticker: string;
  /** Human readable token name (XLS-89 MPTokenMetadata). */
  name: string;
  /** Legal/brand name of the issuing entity (XLS-89 MPTokenMetadata). */
  issuerName: string;
  /** URI of the token icon (XLS-89 MPTokenMetadata). */
  icon: string;
  /** Free-text description (XLS-89 MPTokenMetadata). */
  description?: string;
  /** XLS-89 asset class. Defaults to "rwa" (fiat/real-world-asset backed). */
  assetClass?: MPTokenMetadata["asset_class"];
  /** XLS-89 asset subclass. Required by XLS-89 when assetClass is "rwa"; defaults to "stablecoin". */
  assetSubclass?: MPTokenMetadata["asset_subclass"];
  /** Decimal places for display purposes. Defaults to 0 (whole-unit amounts). */
  assetScale?: number;
  /** Maximum issuable supply, as a string integer. Defaults to no explicit cap. */
  maximumAmount?: string;
  /** Whether holders may transfer directly to each other. Defaults to true. */
  transferable?: boolean;
}

export interface HolderState {
  address: string;
  /** Current MPT balance, as a string integer (in AssetScale units). */
  balance: string;
  /** Issuer has approved this holder on the allowlist (RequireAuth). */
  authorized: boolean;
  /** Issuer has individually frozen/locked this holder. */
  individuallyLocked: boolean;
}

export interface IssuanceState {
  issuanceId: string;
  outstandingAmount: string;
  globallyLocked: boolean;
  requireAuth: boolean;
  canLock: boolean;
  canClawback: boolean;
  canTransfer: boolean;
}

/**
 * Issuer-side control surface for a regulated MPT (Multi-Purpose Token).
 * Wraps the MPTokenIssuanceCreate / MPTokenAuthorize / MPTokenIssuanceSet /
 * Clawback / Payment transactions behind the compliance operations a backend
 * actually needs: allowlisting, clawback, per-holder freeze, global freeze,
 * and banning.
 *
 * All state-changing methods submit-and-wait and throw if the transaction
 * does not land with `tesSUCCESS`, so callers can treat a resolved promise
 * as "applied to a validated ledger."
 */
export class MptIssuer {
  readonly client: Client;
  readonly wallet: Wallet;
  private _issuanceId: string | undefined;

  constructor(client: Client, issuerWallet: Wallet, issuanceId?: string) {
    this.client = client;
    this.wallet = issuerWallet;
    this._issuanceId = issuanceId;
  }

  /** The MPT Issuance ID this instance controls. Throws if not yet created/set. */
  get issuanceId(): string {
    if (this._issuanceId === undefined) {
      throw new Error(
        "MptIssuer has no issuance yet. Call createIssuance() first, or construct " +
          "with an existing issuanceId.",
      );
    }
    return this._issuanceId;
  }

  /**
   * Creates the MPT issuance with the compliance flags this module depends
   * on: RequireAuth (allowlist), CanLock (per-holder + global freeze), and
   * CanClawback (issuer clawback). Returns the new MPT Issuance ID.
   */
  async createIssuance(options: CreateIssuanceOptions): Promise<string> {
    const metadata: MPTokenMetadata = {
      ticker: options.ticker,
      name: options.name,
      issuer_name: options.issuerName,
      icon: options.icon,
      asset_class: options.assetClass ?? "rwa",
      asset_subclass: options.assetSubclass ?? "stablecoin",
      ...(options.description !== undefined ? { desc: options.description } : {}),
    };

    const tx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: this.wallet.address,
      AssetScale: options.assetScale ?? 0,
      MPTokenMetadata: encodeMPTokenMetadata(metadata),
      Flags: {
        tfMPTRequireAuth: true,
        tfMPTCanLock: true,
        tfMPTCanClawback: true,
        tfMPTCanTransfer: options.transferable ?? true,
      },
      ...(options.maximumAmount !== undefined ? { MaximumAmount: options.maximumAmount } : {}),
    };

    const response = await submitAndAssertSuccess(this.client, this.wallet, tx);
    const issuanceId = response.result.meta &&
      typeof response.result.meta === "object"
      ? response.result.meta.mpt_issuance_id
      : undefined;

    if (issuanceId === undefined) {
      throw new Error(
        `MPTokenIssuanceCreate succeeded (tx hash ${response.result.hash}) but the ledger ` +
          "did not return an mpt_issuance_id in its metadata.",
      );
    }

    this._issuanceId = issuanceId;
    return issuanceId;
  }

  /**
   * Approves (allowlists) a holder who has already opted in with their own
   * MPTokenAuthorize transaction. Required before that holder can send or
   * receive this MPT, since the issuance was created with RequireAuth.
   */
  async approveHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.wallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
    };
    await submitAndAssertSuccess(this.client, this.wallet, tx);
  }

  /**
   * Removes a holder from the allowlist without touching their balance or
   * deleting their MPToken object. After this, the holder can neither send
   * nor receive the MPT (RequireAuth rejects unauthorized transfers) until
   * re-approved. Used internally by banHolder(), but also useful standalone.
   */
  async revokeHolderApproval(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: this.wallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    };
    await submitAndAssertSuccess(this.client, this.wallet, tx);
  }

  /** Issues (sends) `value` units of the MPT from the issuer to a holder. */
  async send(destinationAddress: string, value: string | number): Promise<void> {
    const tx: Payment = {
      TransactionType: "Payment",
      Account: this.wallet.address,
      Destination: destinationAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value: String(value) },
    };
    await submitAndAssertSuccess(this.client, this.wallet, tx);
  }

  /** Claws back `value` units of the MPT from a holder, back to the issuer. */
  async clawback(holderAddress: string, value: string | number): Promise<void> {
    const tx: Clawback = {
      TransactionType: "Clawback",
      Account: this.wallet.address,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value: String(value) },
    };
    await submitAndAssertSuccess(this.client, this.wallet, tx);
  }

  /** Freezes a single holder: they can neither send nor receive the MPT. */
  async freezeHolder(holderAddress: string): Promise<void> {
    await this.setHolderLock(holderAddress, true);
  }

  /** Reverses freezeHolder(). */
  async unfreezeHolder(holderAddress: string): Promise<void> {
    await this.setHolderLock(holderAddress, false);
  }

  /** Freezes all movement of the token for every holder (e.g. during an incident). */
  async freezeGlobal(): Promise<void> {
    await this.setGlobalLock(true);
  }

  /** Reverses freezeGlobal(). */
  async unfreezeGlobal(): Promise<void> {
    await this.setGlobalLock(false);
  }

  /**
   * Bans a holder: claws back their entire balance (if any) so they end up
   * holding none of the token, then revokes their allowlist approval so
   * they cannot be paid the MPT again. This is intentionally distinct from
   * freezeHolder()/unfreezeHolder(), which is meant to be reversible.
   */
  async banHolder(holderAddress: string): Promise<void> {
    const state = await this.getHolderState(holderAddress);
    if (state !== null && BigInt(state.balance) > 0n) {
      await this.clawback(holderAddress, state.balance);
    }
    await this.revokeHolderApproval(holderAddress);
  }

  /** Reads a holder's current MPToken state, or null if they never opted in. */
  async getHolderState(holderAddress: string): Promise<HolderState | null> {
    let node: LedgerEntry.MPToken;
    try {
      const response = await this.client.request({
        command: "ledger_entry",
        mptoken: { mpt_issuance_id: this.issuanceId, account: holderAddress },
        ledger_index: "validated",
      });
      if (response.result.node === undefined) {
        return null;
      }
      node = response.result.node as unknown as LedgerEntry.MPToken;
    } catch (err) {
      if (isEntryNotFoundError(err)) {
        return null;
      }
      throw err;
    }

    return {
      address: holderAddress,
      // rippled omits MPTAmount from the JSON entirely when it is the
      // default value of 0, rather than sending an explicit "0".
      balance: node.MPTAmount ?? "0",
      authorized: (node.Flags & MPTOKEN_LEDGER_FLAGS.lsfMPTAuthorized) !== 0,
      individuallyLocked: (node.Flags & MPTOKEN_LEDGER_FLAGS.lsfMPTLocked) !== 0,
    };
  }

  /** Reads the issuance-level state: outstanding supply and control flags. */
  async getIssuanceState(): Promise<IssuanceState> {
    const response = await this.client.request({
      command: "ledger_entry",
      mpt_issuance: this.issuanceId,
      ledger_index: "validated",
    });
    if (response.result.node === undefined) {
      throw new Error(`MPTokenIssuance ${this.issuanceId} not found.`);
    }
    const node = response.result.node as unknown as LedgerEntry.MPTokenIssuance;
    const flags = parseMPTokenIssuanceFlags(node.Flags);

    return {
      issuanceId: this.issuanceId,
      outstandingAmount: node.OutstandingAmount,
      globallyLocked: flags.lsfMPTLocked === true,
      requireAuth: flags.lsfMPTRequireAuth === true,
      canLock: flags.lsfMPTCanLock === true,
      canClawback: flags.lsfMPTCanClawback === true,
      canTransfer: flags.lsfMPTCanTransfer === true,
    };
  }

  private async setHolderLock(holderAddress: string, lock: boolean): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.wallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: lock ? { tfMPTLock: true } : { tfMPTUnlock: true },
    };
    await submitAndAssertSuccess(this.client, this.wallet, tx);
  }

  private async setGlobalLock(lock: boolean): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.wallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? { tfMPTLock: true } : { tfMPTUnlock: true },
    };
    await submitAndAssertSuccess(this.client, this.wallet, tx);
  }
}
