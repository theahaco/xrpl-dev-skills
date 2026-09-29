import { type Client, type MPTokenMetadata, type Wallet } from 'xrpl';
import type { BanList, BanRecord } from './banList.js';
import { type Logger, type ValidatedTransaction } from './submitter.js';
/**
 * Flags on an `MPToken` ledger entry (a holder's balance). xrpl.js does not
 * export these, so they are defined here from the xrpl.org MPToken reference.
 */
export declare const MPTokenFlags: {
    readonly lsfMPTLocked: 1;
    readonly lsfMPTAuthorized: 2;
};
/**
 * Capabilities every issuance managed by this module must have. Without
 * DynamicMPT (not enabled on testnet as of 2026-09-29) these can only be set
 * when the issuance is created, never added afterwards.
 */
export declare const REQUIRED_ISSUANCE_FLAGS: number;
/**
 * Capabilities that must stay off. Escrowed MPT balances are held outside the
 * holder's clawable balance, so escrow would let a holder shield tokens from a
 * ban. DEX trading is not part of this product.
 */
export declare const FORBIDDEN_ISSUANCE_FLAGS: number;
export interface IssuanceState {
    issuanceId: string;
    issuer: string;
    assetScale: number;
    /** Supply cap in token units, if one was set. */
    maximumAmount: string | undefined;
    /** Tokens in circulation, in token units. */
    outstandingAmount: string;
    globallyFrozen: boolean;
    canLock: boolean;
    requireAuth: boolean;
    canTransfer: boolean;
    canClawback: boolean;
    canEscrow: boolean;
    canTrade: boolean;
}
export interface HolderState {
    address: string;
    /** The holder has created an MPToken entry (opted in to hold the token). */
    optedIn: boolean;
    /** The issuer has authorized (allowlisted) this holder. */
    approved: boolean;
    /** The holder's balance is individually locked. */
    frozen: boolean;
    /** Present in the ban list. */
    banned: boolean;
    /** Balance in token units. */
    balance: string;
    balanceBaseUnits: bigint;
}
export interface OperationResult {
    /** False when the ledger was already in the requested state and nothing was submitted. */
    changed: boolean;
    /** Hashes of the validated transactions this operation submitted, in order. */
    transactionHashes: string[];
}
export interface ClawbackResult extends OperationResult {
    /** Amount actually removed from the holder, in token units (read from transaction metadata). */
    clawedBack: string;
}
export interface BanResult extends OperationResult {
    record: BanRecord;
    clawedBack: string;
    /** False if the holder never opted in; the ban list alone then blocks them. */
    holderHadMPToken: boolean;
}
export interface CreateIssuanceOptions {
    /** Decimal places. One whole token = 10^assetScale base units. */
    assetScale: number;
    /** Optional supply cap, in token units. */
    maximumAmount?: string;
    /** XLS-89 metadata. Encoded and size-checked (1024 bytes max) by xrpl.js. */
    metadata: MPTokenMetadata;
}
export interface IssuerDependencies {
    banList: BanList;
    logger?: Logger;
}
/**
 * Issuer-side controls for one regulated MPT issuance.
 *
 * Every mutating method runs exclusively (one at a time per instance), reads
 * validated ledger state, applies the compliance guards, and waits for the
 * transaction to be validated. Methods are idempotent where it makes sense:
 * freezing an already-frozen holder submits nothing and returns
 * `changed: false`.
 *
 * Run only one instance per issuance across the whole backend, or add
 * external locking. Two instances would race on the issuer's account
 * Sequence and on the guard checks.
 */
export declare class MptIssuer {
    #private;
    readonly issuanceId: string;
    readonly assetScale: number;
    private constructor();
    get issuerAddress(): string;
    /** Creates a new issuance with all compliance controls enabled and returns a manager for it. */
    static createIssuance(client: Client, wallet: Wallet, options: CreateIssuanceOptions, deps: IssuerDependencies): Promise<MptIssuer>;
    /**
     * Attaches to an existing issuance. Checks that `wallet` is its issuer and
     * that the issuance has the required controls (and none of the forbidden
     * capabilities).
     */
    static connect(client: Client, wallet: Wallet, issuanceId: string, deps: IssuerDependencies): Promise<MptIssuer>;
    getIssuance(): Promise<IssuanceState>;
    getHolder(address: string): Promise<HolderState>;
    isBanned(address: string): Promise<boolean>;
    /**
     * Approves (allowlists) a holder after KYC. The holder must first opt in
     * by submitting their own MPTokenAuthorize. Banned addresses are refused.
     */
    approveHolder(address: string): Promise<OperationResult>;
    /**
     * Removes a holder from the allowlist. An unapproved holder can neither
     * send nor receive the token, but keeps any existing balance. Use `ban` to
     * also remove the balance.
     */
    revokeApproval(address: string): Promise<OperationResult>;
    /**
     * Sends newly issued tokens to an approved holder.
     *
     * The ledger lets an issuer pay a locked holder, and pay anyone during a
     * global lock (a lock only blocks holder-to-holder transfers). A frozen
     * holder must not receive tokens, so this method checks both freezes
     * before submitting.
     */
    issue(address: string, amount: string): Promise<ValidatedTransaction>;
    /**
     * Claws back `amount` tokens from a holder. If the holder has less, the
     * ledger claws back their whole balance; `clawedBack` reports the actual
     * amount. Works on frozen and unapproved holders.
     */
    clawback(address: string, amount: string): Promise<ClawbackResult>;
    /** Claws back a holder's entire balance. */
    clawbackAll(address: string): Promise<ClawbackResult>;
    /** Locks one holder: they can no longer send to or receive from other holders, or receive from the issuer. */
    freezeHolder(address: string): Promise<OperationResult>;
    /** Unlocks one holder. Refused for banned holders, which stay frozen. */
    unfreezeHolder(address: string): Promise<OperationResult>;
    /** Globally freezes the token: no holder-to-holder transfers, and `issue` is refused. */
    freezeAll(): Promise<OperationResult>;
    /** Lifts the global freeze. Individually frozen holders stay frozen. */
    unfreezeAll(): Promise<OperationResult>;
    /**
     * Bans an address. The steps run in this order, and each one is skipped if
     * already done, so a partially completed ban can be retried safely:
     *
     * 1. Record the ban in the ban list (fail-closed: from here on, approve,
     *    issue and unfreeze are refused for this address).
     * 2. Freeze the holder, so they can't move tokens to someone else while the
     *    ban is in progress.
     * 3. Claw back their entire balance (clawback ignores freezes).
     * 4. Revoke their approval. With RequireAuth on the issuance, the ledger
     *    then rejects any payment to them with `tecNO_AUTH`, including after
     *    they delete and re-create their MPToken entry.
     *
     * Finally it re-reads the ledger and checks that the balance is zero and
     * the holder is unapproved.
     */
    ban(address: string, reason: string): Promise<BanResult>;
    /**
     * Re-applies every ban in the ban list. For example, it re-freezes a banned
     * holder who deleted and re-created their MPToken entry. Safe to run
     * periodically.
     */
    enforceBans(): Promise<BanResult[]>;
}
