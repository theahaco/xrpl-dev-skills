import { Client, Wallet, MPTokenAuthorize, MPTokenIssuanceSet, Clawback, Payment, LedgerEntry, TxResponse } from 'xrpl';
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
type MPToken = LedgerEntry.MPToken;
export declare class MptIssuerError extends Error {
    readonly transactionResult?: string | undefined;
    readonly details?: unknown;
    constructor(message: string, transactionResult?: string | undefined, details?: unknown);
}
export interface CreateIssuanceOptions {
    /** Non-negative integer decimal places for display purposes. Defaults to 0. */
    assetScale?: number;
    /** Maximum amount that may ever be outstanding. Defaults to the protocol maximum. */
    maximumAmount?: string;
    /** Transfer fee in 0.001% increments (0-50000). Requires transfers between holders to be allowed. */
    transferFeeBasisPoints?: number;
    /** Hex-encoded metadata blob (max 1024 bytes), ideally XLS-89 JSON. */
    metadata?: string;
    /** Whether holders may pay each other directly (not just the issuer). Defaults to true. */
    allowHolderToHolderTransfer?: boolean;
}
export interface MptIssuanceInfo {
    issuanceId: string;
    txHash: string;
}
/**
 * Reusable issuer-side controls for a single regulated, allow-listed Multi-Purpose
 * Token (MPT) issuance. Wraps the raw MPTokenIssuanceCreate / MPTokenAuthorize /
 * MPTokenIssuanceSet / Clawback / Payment transactions with the compliance
 * workflows a stablecoin-style issuer needs: allow-listing, per-holder and
 * global freeze, clawback, and permanent bans.
 *
 * One instance is bound to one issuer wallet; callers may manage multiple
 * issuances (e.g. multiple tokens) by calling `createIssuance` more than once
 * and passing the resulting `issuanceId` back into the other methods.
 */
export declare class MptIssuer {
    private readonly client;
    private readonly issuer;
    constructor(client: Client, issuer: Wallet);
    get issuerAddress(): string;
    /**
     * Creates a new MPT issuance with every compliance control enabled:
     * - `tfMPTRequireAuth` so only issuer-approved (allow-listed) holders can hold it.
     * - `tfMPTCanLock` so holders (or the whole issuance) can be frozen and unfrozen.
     * - `tfMPTCanClawback` so the issuer can claw back tokens from any holder.
     */
    createIssuance(options?: CreateIssuanceOptions): Promise<MptIssuanceInfo>;
    /**
     * Holder-side opt-in: signals that `holder` is willing to hold this MPT.
     * This must happen before the issuer can approve the holder, and creates
     * a zero-balance, unauthorized MPToken entry on the holder's account.
     */
    requestHolderOptIn(holder: Wallet, issuanceId: string): Promise<TxResponse<MPTokenAuthorize>>;
    /**
     * Issuer-side approval: grants `holderAddress` permission to hold the MPT
     * (sets `lsfMPTAuthorized` on their MPToken entry). Represents the outcome
     * of a successful KYC check. The holder must have already opted in via
     * `requestHolderOptIn`.
     */
    approveHolder(issuanceId: string, holderAddress: string): Promise<TxResponse<MPTokenAuthorize>>;
    /**
     * Issuer-side revocation: unsets `lsfMPTAuthorized` on `holderAddress`'s
     * MPToken entry, without touching their balance. Because the issuance
     * requires authorization, a revoked holder can no longer send or receive
     * the token until re-approved. Used as the second half of `banHolder`.
     */
    revokeHolderAuthorization(issuanceId: string, holderAddress: string): Promise<TxResponse<MPTokenAuthorize>>;
    /** Freezes a single holder: they can no longer send or receive the MPT. */
    freezeHolder(issuanceId: string, holderAddress: string): Promise<TxResponse<MPTokenIssuanceSet>>;
    /** Reverses `freezeHolder`. */
    unfreezeHolder(issuanceId: string, holderAddress: string): Promise<TxResponse<MPTokenIssuanceSet>>;
    /** Freezes all movement of the token, for every holder, issuance-wide. */
    globalFreeze(issuanceId: string): Promise<TxResponse<MPTokenIssuanceSet>>;
    /** Reverses `globalFreeze`. */
    globalUnfreeze(issuanceId: string): Promise<TxResponse<MPTokenIssuanceSet>>;
    private setLock;
    /** Claws back an exact amount of the token from a holder's balance. */
    clawback(issuanceId: string, holderAddress: string, value: string): Promise<TxResponse<Clawback>>;
    /**
     * Claws back the holder's entire current balance. A clawback `Amount` that
     * exceeds the actual balance simply claws back everything, so this is safe
     * to call even if the balance changes concurrently; if the holder's balance
     * is already zero, no transaction is submitted.
     */
    clawbackAll(issuanceId: string, holderAddress: string): Promise<TxResponse<Clawback> | undefined>;
    /**
     * Permanently bans a holder: claws back their entire balance (if any) and
     * revokes their authorization, so they end up holding none of the token
     * and cannot be paid it again unless explicitly re-approved.
     */
    banHolder(issuanceId: string, holderAddress: string): Promise<void>;
    /** Sends `value` of the MPT from `from` to `destination`. */
    pay(from: Wallet, issuanceId: string, destination: string, value: string): Promise<TxResponse<Payment>>;
    /** Issues (pays) `value` of the MPT from the issuer to `destination`. */
    issueTo(issuanceId: string, destination: string, value: string): Promise<TxResponse<Payment>>;
    getIssuance(issuanceId: string): Promise<MPTokenIssuance | null>;
    getMPToken(issuanceId: string, holderAddress: string): Promise<MPToken | null>;
    getBalance(issuanceId: string, holderAddress: string): Promise<string>;
    isGloballyFrozen(issuanceId: string): Promise<boolean>;
    isHolderFrozen(issuanceId: string, holderAddress: string): Promise<boolean>;
    isHolderAuthorized(issuanceId: string, holderAddress: string): Promise<boolean>;
    private submit;
}
export {};
