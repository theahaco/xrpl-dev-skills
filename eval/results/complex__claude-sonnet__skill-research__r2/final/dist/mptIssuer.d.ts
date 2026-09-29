import { Client, Wallet } from 'xrpl';
export interface SubmittedTx {
    hash: string;
    resultCode: string;
}
export interface CreateIssuanceParams {
    /** Decimal places used for display only; the ledger always stores integers. Defaults to 0. */
    assetScale?: number;
    /** Maximum number of base units that can ever be outstanding. Defaults to the protocol max (2^63-1). */
    maximumAmount?: string;
    /** Secondary-sale transfer fee in 1/100,000ths (0-50000 = 0%-50%). */
    transferFee?: number;
    /** Free-form metadata, conventionally JSON; stored on-ledger as hex. */
    metadata?: string;
    /** Whether holders may pay each other directly, not just the issuer. Defaults to true. */
    allowHolderToHolderTransfers?: boolean;
}
export interface MptIssuanceSnapshot {
    issuanceId: string;
    issuer: string;
    outstandingAmount: string;
    maximumAmount?: string;
    assetScale?: number;
    transferFee?: number;
    requireAuth: boolean;
    canLock: boolean;
    canClawback: boolean;
    canTransfer: boolean;
    globallyLocked: boolean;
}
export interface MptHolderSnapshot {
    account: string;
    issuanceId: string;
    balance: string;
    /** Issuer has approved this holder (relevant when the issuance requires auth). */
    authorized: boolean;
    /** Holder-specific freeze is in effect. */
    locked: boolean;
}
export interface BanHolderResult {
    holder: string;
    /** Amount clawed back from the holder before revoking their authorization, "0" if they held nothing. */
    clawedBack: string;
    clawback?: SubmittedTx;
    revoke: SubmittedTx;
}
/**
 * Issuer-side control surface for a single Multi-Purpose Token issuance,
 * built for a regulated / stablecoin-style deployment:
 *
 *  - Allowlist: the issuance is created with tfMPTRequireAuth, so only
 *    holders the issuer explicitly authorizes can hold a balance.
 *  - Clawback: created with tfMPTCanClawback.
 *  - Per-holder and global freeze: created with tfMPTCanLock.
 *  - Bans: implemented as clawback-to-zero + revoking the holder's
 *    authorization, so a banned address can neither hold nor receive
 *    the token again.
 *
 * All state-changing methods submit a signed transaction and wait for
 * validated, tesSUCCESS confirmation before resolving; on any other
 * outcome they throw.
 */
export declare class MptIssuer {
    private readonly client;
    private readonly wallet;
    private mptIssuanceId;
    constructor(client: Client, issuerWallet: Wallet, issuanceId?: string);
    get issuerAddress(): string;
    get issuanceId(): string;
    private submit;
    /** Creates the MPT issuance with allowlist, clawback, and lock (freeze) capability enabled. */
    createIssuance(params?: CreateIssuanceParams): Promise<{
        issuanceId: string;
    } & SubmittedTx>;
    /**
     * Allowlists a holder who has already opted in (submitted their own
     * MPTokenAuthorize). Required before that holder can send or receive
     * the token, since the issuance requires auth.
     */
    approveHolder(holderAddress: string): Promise<SubmittedTx>;
    /**
     * Revokes a previously-approved holder's authorization, without
     * touching their balance. After this, the holder can no longer send or
     * receive the token. Used by banHolder(); exposed directly in case
     * callers need to de-allowlist someone who already holds a zero balance.
     */
    revokeHolderApproval(holderAddress: string): Promise<SubmittedTx>;
    /**
     * Sends `value` base units of the token from the issuer to an approved
     * holder.
     *
     * Note on freeze semantics: at the protocol level, an MPT lock (global or
     * per-holder) only blocks transfers *initiated by the holder* to third
     * parties — it does not, by itself, stop the issuer from paying a locked
     * holder directly (the same as classic trust-line freeze, which keeps the
     * issuer/holder relationship open for remediation). Since the compliance
     * requirement here is that a frozen holder can neither send nor receive,
     * this method enforces the "receive" half itself by refusing to send to a
     * holder or issuance that is currently locked.
     */
    send(destinationAddress: string, value: string): Promise<SubmittedTx>;
    /** Claws back `value` base units of the token from a holder, regardless of freeze state. */
    clawback(holderAddress: string, value: string): Promise<SubmittedTx>;
    /** Freezes a single holder: they can neither send nor receive the token. */
    freezeHolder(holderAddress: string): Promise<SubmittedTx>;
    /** Lifts a previously-applied per-holder freeze. */
    unfreezeHolder(holderAddress: string): Promise<SubmittedTx>;
    /** Freezes all movement of the token, for every holder, e.g. during an incident. */
    globalFreeze(): Promise<SubmittedTx>;
    /** Lifts a previously-applied global freeze. */
    globalUnfreeze(): Promise<SubmittedTx>;
    /**
     * Bans a holder: claws back their entire balance (if any) so they end up
     * holding none of the token, then revokes their authorization so they
     * cannot be paid again while the issuance requires auth. Once the balance
     * is zero, revoking authorization deletes the holder's MPToken object
     * entirely (refunding their reserve) rather than merely clearing a flag,
     * so getHolderMPToken()/getHolderBalance() may report the holder as
     * absent afterward — treat that the same as balance "0" / unauthorized.
     */
    banHolder(holderAddress: string): Promise<BanHolderResult>;
    /** Reads the current on-ledger state of the issuance itself. */
    getIssuance(): Promise<MptIssuanceSnapshot>;
    /** Reads a specific holder's MPToken object, or null if they have never opted in (or have since deleted it). */
    getHolderMPToken(holderAddress: string): Promise<MptHolderSnapshot | null>;
    /** Convenience wrapper over getHolderMPToken() that returns "0" instead of null for holders with no MPToken object. */
    getHolderBalance(holderAddress: string): Promise<string>;
}
/**
 * Holder-signed opt-in: creates the holder's MPToken object for this
 * issuance. Must happen before the issuer can approveHolder() them, since
 * MPTokenAuthorize requires the holder's MPToken to already exist.
 */
export declare function optInHolder(client: Client, holderWallet: Wallet, issuanceId: string): Promise<SubmittedTx>;
