/**
 * Issuer-side controls for a regulated, stablecoin-style Multi-Purpose Token
 * (XLS-33) on the XRP Ledger.
 *
 * Controls and how they map onto the protocol:
 *
 * | Control           | Ledger mechanism                                                   |
 * | ----------------- | ------------------------------------------------------------------ |
 * | Allowlist         | lsfMPTRequireAuth + MPTokenAuthorize (issuer, Holder)               |
 * | Clawback          | lsfMPTCanClawback + Clawback (Holder)                              |
 * | Per-holder freeze | lsfMPTCanLock + MPTokenIssuanceSet tfMPTLock/tfMPTUnlock (Holder)  |
 * | Global freeze     | lsfMPTCanLock + MPTokenIssuanceSet tfMPTLock/tfMPTUnlock           |
 * | Ban               | ban store + lock + claw back entire balance + revoke authorization |
 *
 * Capability flags can only be set when the issuance is created while the
 * DynamicMPT amendment is not enabled (as on testnet and mainnet at the time
 * of writing), so `createIssuance` always sets every flag the controls need,
 * and `open` refuses to manage an issuance that is missing any of them.
 *
 * Operations on one `MptIssuer` instance are serialized, so the
 * read-check-submit sequence inside each operation can't interleave with
 * another operation from the same process. Run a single instance per issuer
 * account; independent processes signing for the same account will race on
 * the account Sequence.
 */
import { type Client, type MPTokenMetadata, type TransactionMetadata, type Wallet } from 'xrpl';
import type { BanRecord, BanStore } from './banStore.js';
import { type ValidatedTransaction } from './ledger.js';
/** Flags every issuance managed by this module must have. */
export declare const REQUIRED_ISSUANCE_FLAGS: number;
export interface Logger {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
}
export interface IssuanceOptions {
    /** Number of decimal places, e.g. 2 for cents. Cannot be changed later. Default 0. */
    assetScale?: number;
    /** Supply cap in display units (e.g. "1000000"). Omit for the protocol maximum. */
    maximumAmount?: string;
    /** XLS-89 metadata; validated and encoded by xrpl.js. */
    metadata?: MPTokenMetadata;
}
export interface IssuerOptions {
    banStore: BanStore;
    logger?: Logger;
}
export interface IssuanceState {
    issuanceId: string;
    issuer: string;
    assetScale: number;
    outstandingAmount: string;
    maximumAmount: string | undefined;
    globallyFrozen: boolean;
    flags: number;
}
export interface HolderState {
    address: string;
    /** Whether the holder has an MPToken entry for this issuance (i.e. has opted in). */
    optedIn: boolean;
    balance: string;
    rawBalance: bigint;
    authorized: boolean;
    frozen: boolean;
    banned: boolean;
}
export interface OperationResult {
    /** False when the ledger was already in the requested state and nothing was submitted. */
    changed: boolean;
    transactions: ValidatedTransaction[];
}
export interface ClawbackResult extends OperationResult {
    /** Amount actually removed from the holder, in display units, read from the validated metadata. */
    clawedBack: string;
}
export interface BanResult extends OperationResult {
    clawedBack: string;
    record: BanRecord;
}
export declare class MptIssuer {
    #private;
    readonly issuanceId: string;
    readonly assetScale: number;
    private constructor();
    get issuerAddress(): string;
    /** Create a new issuance with every compliance control enabled, and return a manager for it. */
    static createIssuance(client: Client, wallet: Wallet, issuance: IssuanceOptions, options: IssuerOptions): Promise<MptIssuer>;
    /** Manage an existing issuance. Verifies the wallet is its issuer and that every control is available. */
    static open(client: Client, wallet: Wallet, issuanceId: string, options: IssuerOptions): Promise<MptIssuer>;
    getIssuance(): Promise<IssuanceState>;
    getHolder(address: string): Promise<HolderState>;
    isBanned(address: string): Promise<boolean>;
    listBans(): Promise<BanRecord[]>;
    /**
     * Approve a KYC'd holder. The holder must first opt in by submitting their
     * own MPTokenAuthorize, which creates their MPToken entry.
     */
    authorizeHolder(address: string): Promise<OperationResult>;
    /**
     * Revoke a holder's approval (e.g. expired KYC). They keep any balance they
     * hold but can no longer receive or send the token. Use `ban` to also
     * remove their balance.
     */
    revokeAuthorization(address: string): Promise<OperationResult>;
    /** Issue (mint) `amount` display units of the token to an approved holder. */
    issue(address: string, amount: string): Promise<OperationResult>;
    /**
     * Claw back `amount` display units, or `'all'` of the holder's balance.
     * Works regardless of whether the holder is frozen or still authorized.
     */
    clawback(address: string, amount: string | 'all'): Promise<ClawbackResult>;
    /**
     * Freeze one holder: the ledger stops them sending the token to, or
     * receiving it from, other holders (they can still send it back to the
     * issuer). The ledger does NOT stop the issuer paying a frozen holder;
     * `issue` refuses to, so always issue through this module.
     */
    freezeHolder(address: string): Promise<OperationResult>;
    unfreezeHolder(address: string): Promise<OperationResult>;
    /** Freeze all movement of the token between holders. `issue` also refuses to mint while frozen. */
    freezeAll(): Promise<OperationResult>;
    unfreezeAll(): Promise<OperationResult>;
    /**
     * Ban an address: record the ban, freeze the holder, claw back their entire
     * balance and revoke their authorization. Afterwards the address holds none
     * of the token and the ledger rejects any payment to it; the ban store
     * stops this module from ever re-approving it.
     *
     * Idempotent: if any step fails, calling `ban` again resumes where it stopped.
     */
    ban(address: string, reason: string): Promise<BanResult>;
}
/** Balance reduction of the holder's MPToken in a validated Clawback's metadata. */
export declare function clawedBackFromMeta(meta: TransactionMetadata, issuanceId: string, holder: string): bigint;
