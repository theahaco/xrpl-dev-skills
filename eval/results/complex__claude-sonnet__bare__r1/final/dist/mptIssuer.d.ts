/**
 * Reusable issuer-side module for a regulated, stablecoin-style token on the
 * XRP Ledger, built on Multi-Purpose Tokens (MPTs).
 *
 * Compliance controls implemented:
 *  - Allowlist: `tfMPTRequireAuth` on the issuance + per-holder authorization
 *    via `MPTokenAuthorize`. Only authorized holders can hold a balance.
 *  - Clawback: `tfMPTCanClawback` on the issuance + `Clawback` transactions.
 *  - Bans: clawback the holder's full balance, then revoke their
 *    authorization so they can never receive the token again.
 *  - Per-holder freeze: `MPTokenIssuanceSet` with a `Holder` field and
 *    `tfMPTLock` / `tfMPTUnlock`.
 *  - Global freeze: `MPTokenIssuanceSet` with no `Holder` field and
 *    `tfMPTLock` / `tfMPTUnlock`.
 *
 * All issuer-signing operations live on the `MPTIssuer` class. Opting a
 * holder in (`optInToIssuance`) is the one operation a holder's own wallet
 * performs, not the issuer; it is exported separately for test/demo use.
 */
import { Client, Wallet, TxResponse, LedgerEntry } from 'xrpl';
type MPToken = LedgerEntry.MPToken;
export declare class MPTIssuerError extends Error {
    readonly transactionType: string | undefined;
    readonly resultCode: string | undefined;
    constructor(message: string, options?: {
        transactionType?: string | undefined;
        resultCode?: string | undefined;
    });
}
export interface CreateIssuanceParams {
    /** Non-negative integer; 10^-scale of a standard unit. Defaults to 0 (whole units). */
    assetScale?: number;
    /** Maximum amount that may ever be issued, as a base-10 integer string. */
    maximumAmount?: string;
    /** Transfer fee in tenths of a basis point (0-50000). Requires transfers to be enabled. */
    transferFee?: number;
    /** Hex-encoded MPTokenMetadata blob (see XLS-89). */
    metadataHex?: string;
    /** Allow holders to transfer the token to other holders (not just to/from the issuer). Defaults to true. */
    transferable?: boolean;
}
export interface HolderState {
    address: string;
    exists: boolean;
    authorized: boolean;
    locked: boolean;
    balance: string;
}
export interface IssuanceState {
    issuanceId: string;
    issuer: string;
    globallyLocked: boolean;
    requiresAuth: boolean;
    canClawback: boolean;
    canLock: boolean;
    canTransfer: boolean;
    outstandingAmount: string;
    maximumAmount?: string;
    assetScale?: number;
}
/**
 * The issuer-side MPT controller. One instance manages exactly one
 * MPTokenIssuance, signed for by the issuer's wallet.
 */
export declare class MPTIssuer {
    readonly client: Client;
    readonly wallet: Wallet;
    readonly issuanceId: string;
    constructor(client: Client, issuerWallet: Wallet, issuanceId: string);
    /**
     * Creates a new MPTokenIssuance with the compliance-control flags enabled
     * (allowlist, clawback, lock/freeze) and returns a ready-to-use MPTIssuer.
     */
    static create(client: Client, issuerWallet: Wallet, params?: CreateIssuanceParams): Promise<MPTIssuer>;
    private static submit;
    private submit;
    /**
     * Authorizes a holder who has already opted in (via {@link optInToIssuance}),
     * allowing them to hold and receive this MPT. Required before any payment
     * to that holder will succeed, since the issuance was created with
     * `tfMPTRequireAuth`.
     */
    approveHolder(holderAddress: string): Promise<TxResponse>;
    /**
     * Revokes a holder's authorization. Their existing balance is untouched by
     * this call alone; combine with {@link clawback} (see {@link ban}) to also
     * remove funds. Does not delete the holder's MPToken object.
     */
    revokeHolderAuthorization(holderAddress: string): Promise<TxResponse>;
    /** Sends `amount` (base units, as a string) of this MPT from the issuer to `to`. */
    send(to: string, amount: string): Promise<TxResponse>;
    /** Claws back `amount` (base units, as a string) of this MPT from `holder`. */
    clawback(holder: string, amount: string): Promise<TxResponse>;
    /**
     * Bans a holder: claws back their entire balance (if any) and revokes
     * their authorization, so they end up holding none of the token and
     * cannot be paid it again (payments to an unauthorized holder are
     * rejected while `tfMPTRequireAuth` is set on the issuance).
     */
    ban(holderAddress: string): Promise<TxResponse[]>;
    /**
     * Freezes an individual holder: they can no longer send this MPT to, or
     * receive it from, any other holder (`tecLOCKED`). Per the MPT protocol
     * design, a lock does not block movement directly to/from the issuer
     * (e.g. redemption or issuer-driven distribution/clawback still work) —
     * it blocks the holder from moving the token around the rest of the
     * ecosystem while a compliance issue is investigated.
     */
    freezeHolder(holderAddress: string): Promise<TxResponse>;
    /** Lifts an individual freeze on a holder. */
    unfreezeHolder(holderAddress: string): Promise<TxResponse>;
    /**
     * Freezes all holder-to-holder movement of this MPT (`tecLOCKED`), e.g.
     * during an incident. As with per-holder locks, issuer-to-holder and
     * holder-to-issuer payments are unaffected, so the issuer retains the
     * ability to manage the token (clawback, distribute) while the freeze
     * is in effect.
     */
    globalFreeze(): Promise<TxResponse>;
    /** Lifts the global freeze on this MPT. */
    globalUnfreeze(): Promise<TxResponse>;
    /** Fetches the MPTokenIssuance ledger object and decodes its flags. */
    getIssuanceState(): Promise<IssuanceState>;
    /**
     * Fetches a holder's MPToken ledger object (their opt-in/authorization/
     * balance/lock record for this issuance), or `undefined` if they have
     * never opted in.
     */
    getHolderMPToken(holderAddress: string): Promise<MPToken | undefined>;
    /** Convenience summary of a holder's state (balance, authorized?, locked?). */
    getHolderState(holderAddress: string): Promise<HolderState>;
    getBalance(holderAddress: string): Promise<string>;
}
/**
 * Opts a holder in to an MPTokenIssuance. This transaction must be signed by
 * the holder's own wallet (not the issuer's) — it is the on-chain equivalent
 * of a customer saying "I want to be able to hold this token." The issuer
 * must still call {@link MPTIssuer.approveHolder} afterwards before the
 * holder can receive a balance, since the issuance requires authorization.
 */
export declare function optInToIssuance(client: Client, holderWallet: Wallet, issuanceId: string): Promise<TxResponse>;
export {};
