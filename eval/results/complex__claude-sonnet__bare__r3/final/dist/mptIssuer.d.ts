/**
 * Issuer-side controls for a regulated Multi-Purpose Token (MPT) on the XRP Ledger.
 *
 * The issuance is created with:
 *   - tfMPTRequireAuth  -> allowlist: only issuer-approved holders can hold the token
 *   - tfMPTCanLock      -> per-holder and global freeze
 *   - tfMPTCanClawback  -> issuer can claw back tokens from any holder
 *   - tfMPTCanTransfer  -> the token can move between non-issuer accounts
 *
 * "Ban" is not a native MPT primitive. It is implemented here as the composition of the
 * three primitives above: sweep the holder's balance to zero (Clawback), lock their
 * MPToken so it can't move (MPTokenIssuanceSet + Holder), and revoke their allowlist
 * authorization (MPTokenAuthorize + tfMPTUnauthorize) so RequireAuth blocks any future
 * incoming payment. A banned holder is also recorded so this module refuses to
 * re-approve them later, even though nothing here would resurrect the address on its own.
 */
import { Client, Wallet, SubmittableTransaction, TxResponse } from 'xrpl';
/** Anything that can hold/receive an amount: a full Wallet, or just a classic address string. */
export type Holder = Wallet | string;
export interface CreateIssuanceOptions {
    /** Decimal places used only for display; the ledger stores integer base units. Default 0. */
    assetScale?: number;
    /** Maximum issuable amount, as a base-10 string. Default: no practical cap (2^63-1). */
    maximumAmount?: string;
    /** Arbitrary metadata (e.g. `{"name":"Example USD","ticker":"EUSD"}`), stored as hex on ledger. */
    metadata?: string | Record<string, unknown>;
    /** Transfer fee in 0.001% units (0-50000). Requires transfers to be enabled. Default 0. */
    transferFee?: number;
}
export interface IssuanceState {
    issuanceId: string;
    issuer: string;
    outstandingAmount: string;
    maximumAmount?: string;
    globallyLocked: boolean;
    requireAuth: boolean;
    canClawback: boolean;
    canLock: boolean;
    canTransfer: boolean;
}
export interface HolderState {
    holder: string;
    issuanceId: string;
    /** False if the holder has never opted in (no MPToken object exists on ledger). */
    exists: boolean;
    balance: string;
    authorized: boolean;
    locked: boolean;
}
/** Thrown when a submitted transaction lands on-ledger but does not succeed (non-tes* result). */
export declare class MptTransactionError extends Error {
    readonly transactionType: string;
    readonly transactionResult: string;
    readonly txHash?: string | undefined;
    constructor(transactionType: string, transactionResult: string, txHash?: string | undefined);
}
/** Thrown when trying to approve a holder this module has previously banned. */
export declare class HolderBannedError extends Error {
    readonly holder: string;
    constructor(holder: string);
}
export declare class MptIssuer {
    private readonly client;
    private readonly issuer;
    private readonly bannedHolders;
    constructor(client: Client, issuer: Wallet);
    get issuerAddress(): string;
    /** Signs and submits a transaction from the issuer's wallet, waits for validation, and throws unless it succeeded. */
    private submitAsIssuer;
    /** Creates the MPT issuance with allowlist, freeze, and clawback all enabled. Returns the new issuance ID. */
    createIssuance(options?: CreateIssuanceOptions): Promise<string>;
    /**
     * Approves a holder who has already opted in (see `optInToMpt`) to hold this MPT.
     * Call this only after your KYC process has cleared the holder.
     */
    approveHolder(holder: Holder, issuanceId: string): Promise<void>;
    /** Revokes a holder's allowlist authorization without touching their balance or lock state. */
    revokeHolderAuthorization(holder: Holder, issuanceId: string): Promise<void>;
    /** Sends `value` base units of the MPT from the issuer to an approved holder. */
    sendFromIssuer(to: Holder, issuanceId: string, value: string): Promise<void>;
    /** Claws back `value` base units of the MPT from a holder. If it exceeds their balance, the whole balance is taken. */
    clawback(holder: Holder, issuanceId: string, value: string): Promise<void>;
    /** Claws back a holder's entire current balance. No-ops if they hold none (or never opted in). */
    clawbackAll(holder: Holder, issuanceId: string): Promise<void>;
    freezeHolder(holder: Holder, issuanceId: string): Promise<void>;
    unfreezeHolder(holder: Holder, issuanceId: string): Promise<void>;
    freezeGlobal(issuanceId: string): Promise<void>;
    unfreezeGlobal(issuanceId: string): Promise<void>;
    private setLock;
    /**
     * Bans a holder: sweeps their balance to zero, locks their MPToken so it cannot move,
     * and revokes their allowlist authorization so they cannot be paid again while
     * RequireAuth is enforced. The holder is also remembered so `approveHolder` refuses
     * to re-admit them later via this module instance.
     *
     * In a production deployment, back this module's banned-holder set with persistent
     * storage (e.g. a database row per holder) rather than the in-memory Set used here,
     * so the ban survives a process restart.
     */
    banHolder(holder: Holder, issuanceId: string): Promise<void>;
    isBanned(holder: Holder): boolean;
    getIssuanceState(issuanceId: string): Promise<IssuanceState>;
    getHolderState(holder: Holder, issuanceId: string): Promise<HolderState>;
    private findLedgerEntry;
}
/**
 * Opts a holder in to an MPT issuance. This must be signed by the holder themselves
 * (self-custody) before the issuer can approve them with `MptIssuer.approveHolder`.
 */
export declare function optInToMpt(client: Client, holder: Wallet, issuanceId: string): Promise<void>;
export declare function submitAndAssertSuccess<T extends SubmittableTransaction>(client: Client, wallet: Wallet, tx: T): Promise<TxResponse<T>>;
