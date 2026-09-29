import type { Client, MPTokenMetadata, TxResponse, Wallet } from "xrpl";
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
export declare class MptIssuer {
    private readonly client;
    private readonly issuerWallet;
    constructor(client: Client, issuerWallet: Wallet);
    get issuerAddress(): string;
    /**
     * Creates the MPT issuance with the full compliance control surface
     * enabled: authorization-gated holding (allowlist), per-holder and
     * global freeze (lock), and clawback. Returns the new issuance ID.
     */
    createIssuance(params: CreateIssuanceParams): Promise<{
        issuanceId: string;
        hash: string;
    }>;
    /**
     * Allowlist: approves a holder who has already opted in (submitted their
     * own `MPTokenAuthorize`). Required before that holder can receive or
     * send the token, since the issuance is created with `tfMPTRequireAuth`.
     */
    approveHolder(issuanceId: string, holderAddress: string): Promise<TxResponse>;
    /** Sends `value` (in display units) of the token from the issuer to a holder. */
    sendTokens(issuanceId: string, holderAddress: string, value: string): Promise<TxResponse>;
    /** Claws back `value` (in display units) of the token from a holder, back to the issuer. */
    clawback(issuanceId: string, holderAddress: string, value: string): Promise<TxResponse>;
    /**
     * Per-holder freeze: blocks this holder from sending or receiving the
     * token to or from any other holder. The issuer itself remains an exempt
     * counterparty (as with classic trust-line freezes) so that `clawback`
     * and issuer-initiated payments keep working on a frozen account.
     */
    freezeHolder(issuanceId: string, holderAddress: string): Promise<TxResponse>;
    /** Lifts a per-holder freeze. */
    unfreezeHolder(issuanceId: string, holderAddress: string): Promise<TxResponse>;
    /**
     * Global freeze: blocks movement of the token between any two holders,
     * for the whole issuance at once (e.g. during an incident). As with
     * `freezeHolder`, the issuer remains an exempt counterparty, so this does
     * not prevent the issuer from still running `clawback` or administrative
     * payments while the freeze is in effect.
     */
    globalFreeze(issuanceId: string): Promise<TxResponse>;
    /** Lifts a global freeze. */
    globalUnfreeze(issuanceId: string): Promise<TxResponse>;
    /**
     * Bans a holder: claws back their entire balance (if any) so they end up
     * holding none of the token, then revokes their authorization so they
     * cannot be paid again while the issuance requires authorization. This is
     * NOT the same as a freeze — authorization revocation is not reversible
     * via `unfreezeHolder`; a banned holder would need to be re-approved via
     * `approveHolder` to ever hold the token again.
     */
    banHolder(issuanceId: string, holderAddress: string): Promise<TxResponse[]>;
    /** Reads the issuance's current supply and compliance-flag state. */
    getIssuance(issuanceId: string): Promise<IssuanceState>;
    /** Reads a holder's balance, authorization, and freeze state. Returns
     * `null` if the holder has never opted in (no MPToken object exists). */
    getHolder(issuanceId: string, holderAddress: string): Promise<HolderState | null>;
}
