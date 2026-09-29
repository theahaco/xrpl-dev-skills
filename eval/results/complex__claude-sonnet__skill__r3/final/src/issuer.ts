import type { Client, MPTokenMetadata, TxResponse, Wallet } from "xrpl";
import {
  encodeMPTokenMetadata,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  parseMPTokenIssuanceFlags,
} from "xrpl";

import { submitAndVerify } from "./txSubmit";
import { hasFlag, MPTokenFlags } from "./mptFlags";

export interface CreateIssuanceParams {
  /** Number of decimal places used when displaying amounts (0-19). The
   * ledger itself always stores/transfers raw integers; see `src/amounts.ts`. */
  assetScale: number;
  /** Maximum total supply, in raw base units (a string integer). */
  maximumAmount: string;
  /** Transfer fee in basis points of a unit's value (0-50000, i.e. 0-50%). */
  transferFee?: number;
  /** Structured token metadata (XLS-89), hex-encoded onto the wire via the
   * SDK's `encodeMPTokenMetadata`. */
  metadata?: MPTokenMetadata;
  /** Whether holders may transfer to each other (not just to/from the issuer).
   * Defaults to true. */
  allowHolderToHolderTransfer?: boolean;
}

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  outstandingAmount: string;
  maximumAmount?: string;
  assetScale?: number;
  transferFee?: number;
  globallyLocked: boolean;
  requireAuth: boolean;
  canClawback: boolean;
  canLock: boolean;
}

export interface HolderState {
  issuanceId: string;
  holder: string;
  balance: string;
  authorized: boolean;
  locked: boolean;
}

/**
 * Issuer-side control plane for a single regulated MPT issuance.
 *
 * Every mutating method submits exactly one XRPL transaction (except
 * `banHolder`, which is a clawback-then-revoke compound operation), waits
 * for ledger validation, and throws `TransactionFailedError` on any
 * non-`tesSUCCESS` result. Callers should treat a resolved promise as proof
 * the effect is durably recorded on the ledger.
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
   * Creates the MPT issuance with the full compliance control surface
   * enabled: authorization-gated holding (allowlist), per-holder and
   * global freeze (lock), and clawback. Returns the new issuance ID.
   */
  async createIssuance(params: CreateIssuanceParams): Promise<{ issuanceId: string; hash: string }> {
    let flags =
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback;
    if (params.allowHolderToHolderTransfer ?? true) {
      flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
    }

    const response = await submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: this.issuerAddress,
      AssetScale: params.assetScale,
      MaximumAmount: params.maximumAmount,
      ...(params.transferFee !== undefined ? { TransferFee: params.transferFee } : {}),
      ...(params.metadata !== undefined
        ? { MPTokenMetadata: encodeMPTokenMetadata(params.metadata) }
        : {}),
      Flags: flags,
    });

    const issuanceId = response.result.meta && typeof response.result.meta === "object"
      ? (response.result.meta as { mpt_issuance_id?: string }).mpt_issuance_id
      : undefined;
    if (!issuanceId) {
      throw new Error("MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned");
    }

    return { issuanceId, hash: response.result.hash };
  }

  /**
   * Allowlist: approves a holder who has already opted in (submitted their
   * own `MPTokenAuthorize`). Required before that holder can receive or
   * send the token, since the issuance is created with `tfMPTRequireAuth`.
   */
  async approveHolder(issuanceId: string, holderAddress: string): Promise<TxResponse> {
    return submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "MPTokenAuthorize",
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
    });
  }

  /** Sends `value` (in display units) of the token from the issuer to a holder. */
  async sendTokens(issuanceId: string, holderAddress: string, value: string): Promise<TxResponse> {
    return submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "Payment",
      Account: this.issuerAddress,
      Destination: holderAddress,
      Amount: { mpt_issuance_id: issuanceId, value },
    });
  }

  /** Claws back `value` (in display units) of the token from a holder, back to the issuer. */
  async clawback(issuanceId: string, holderAddress: string, value: string): Promise<TxResponse> {
    return submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "Clawback",
      Account: this.issuerAddress,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: issuanceId, value },
    });
  }

  /**
   * Per-holder freeze: blocks this holder from sending or receiving the
   * token to or from any other holder. The issuer itself remains an exempt
   * counterparty (as with classic trust-line freezes) so that `clawback`
   * and issuer-initiated payments keep working on a frozen account.
   */
  async freezeHolder(issuanceId: string, holderAddress: string): Promise<TxResponse> {
    return submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
      Flags: MPTokenIssuanceSetFlags.tfMPTLock,
    });
  }

  /** Lifts a per-holder freeze. */
  async unfreezeHolder(issuanceId: string, holderAddress: string): Promise<TxResponse> {
    return submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
      Flags: MPTokenIssuanceSetFlags.tfMPTUnlock,
    });
  }

  /**
   * Global freeze: blocks movement of the token between any two holders,
   * for the whole issuance at once (e.g. during an incident). As with
   * `freezeHolder`, the issuer remains an exempt counterparty, so this does
   * not prevent the issuer from still running `clawback` or administrative
   * payments while the freeze is in effect.
   */
  async globalFreeze(issuanceId: string): Promise<TxResponse> {
    return submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Flags: MPTokenIssuanceSetFlags.tfMPTLock,
    });
  }

  /** Lifts a global freeze. */
  async globalUnfreeze(issuanceId: string): Promise<TxResponse> {
    return submitAndVerify(this.client, this.issuerWallet, {
      TransactionType: "MPTokenIssuanceSet",
      Account: this.issuerAddress,
      MPTokenIssuanceID: issuanceId,
      Flags: MPTokenIssuanceSetFlags.tfMPTUnlock,
    });
  }

  /**
   * Bans a holder: claws back their entire balance (if any) so they end up
   * holding none of the token, then revokes their authorization so they
   * cannot be paid again while the issuance requires authorization. This is
   * NOT the same as a freeze — authorization revocation is not reversible
   * via `unfreezeHolder`; a banned holder would need to be re-approved via
   * `approveHolder` to ever hold the token again.
   */
  async banHolder(issuanceId: string, holderAddress: string): Promise<TxResponse[]> {
    const results: TxResponse[] = [];

    const holderState = await this.getHolder(issuanceId, holderAddress);
    if (holderState && BigInt(holderState.balance) > 0n) {
      results.push(await this.clawback(issuanceId, holderAddress, holderState.balance));
    }

    results.push(
      await submitAndVerify(this.client, this.issuerWallet, {
        TransactionType: "MPTokenAuthorize",
        Account: this.issuerAddress,
        MPTokenIssuanceID: issuanceId,
        Holder: holderAddress,
        Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
      }),
    );

    return results;
  }

  /** Reads the issuance's current supply and compliance-flag state. */
  async getIssuance(issuanceId: string): Promise<IssuanceState> {
    const response = await this.client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const node = response.result.node;
    if (node.LedgerEntryType !== "MPTokenIssuance") {
      throw new Error(`Expected an MPTokenIssuance ledger entry, got ${node.LedgerEntryType}`);
    }
    const flags = parseMPTokenIssuanceFlags(node.Flags);

    return {
      issuanceId,
      issuer: node.Issuer,
      outstandingAmount: node.OutstandingAmount,
      maximumAmount: node.MaximumAmount,
      assetScale: node.AssetScale,
      transferFee: node.TransferFee,
      globallyLocked: flags.lsfMPTLocked ?? false,
      requireAuth: flags.lsfMPTRequireAuth ?? false,
      canClawback: flags.lsfMPTCanClawback ?? false,
      canLock: flags.lsfMPTCanLock ?? false,
    };
  }

  /** Reads a holder's balance, authorization, and freeze state. Returns
   * `null` if the holder has never opted in (no MPToken object exists). */
  async getHolder(issuanceId: string, holderAddress: string): Promise<HolderState | null> {
    try {
      const response = await this.client.request({
        command: "ledger_entry",
        mptoken: { mpt_issuance_id: issuanceId, account: holderAddress },
        ledger_index: "validated",
      });
      // The xrpl.js `LedgerEntry` union type omits `MPToken` (a gap in the
      // SDK's type definitions as of v5.3.0), so we narrow through
      // `unknown` and verify the discriminant at runtime instead.
      const node = response.result.node as unknown as {
        LedgerEntryType: string;
        MPTAmount: string;
        Flags: number;
      };
      if (node.LedgerEntryType !== "MPToken") {
        throw new Error(`Expected an MPToken ledger entry, got ${node.LedgerEntryType}`);
      }

      return {
        issuanceId,
        holder: holderAddress,
        balance: node.MPTAmount ?? "0",
        authorized: hasFlag(node.Flags, MPTokenFlags.lsfMPTAuthorized),
        locked: hasFlag(node.Flags, MPTokenFlags.lsfMPTLocked),
      };
    } catch (error) {
      if (error instanceof Error && "data" in error) {
        const data = (error as Error & { data?: { error?: string } }).data;
        if (data?.error === "entryNotFound") {
          return null;
        }
      }
      throw error;
    }
  }
}
