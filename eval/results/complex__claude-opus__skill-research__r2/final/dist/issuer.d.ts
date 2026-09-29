import { type Client, type MPTokenMetadata, type Wallet } from 'xrpl';
import type { BanRecord, BanRegistry } from './ban-registry.js';
import { type TxOutcome } from './ledger.js';
/** Amendments the issuer's controls depend on. */
export declare const REQUIRED_AMENDMENTS: readonly ['MPTokensV1', 'Clawback'];
export interface Logger {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
}
export interface IssuerDeps {
    /** A connected client. */
    client: Client;
    issuerWallet: Wallet;
    banRegistry: BanRegistry;
    /** If set, every operation first checks that the client is on this network (testnet = 1, mainnet = 0). */
    expectedNetworkId?: number;
    logger?: Logger;
}
export interface CreateIssuanceOptions {
    /** Decimal places of the token (0-19). Amounts in this API are display units at this scale. */
    assetScale: number;
    /** Supply cap in display units. Defaults to the ledger maximum. */
    maximumAmount?: string;
    /** XLS-89 metadata. */
    metadata?: MPTokenMetadata;
    /** Allow holder-to-holder transfers. Defaults to true. */
    allowHolderTransfers?: boolean;
    /** Issuer fee on holder-to-holder transfers, in units of 0.001% (0-50000). Requires transfers. */
    transferFee?: number;
}
export interface IssuanceState {
    issuanceId: string;
    issuer: string;
    assetScale: number;
    outstanding: string;
    maximum: string | undefined;
    globallyFrozen: boolean;
    canLock: boolean;
    requireAuth: boolean;
    canClawback: boolean;
    canTransfer: boolean;
    canEscrow: boolean;
    canTrade: boolean;
    flags: number;
}
export interface HolderState {
    address: string;
    /** Whether the holder has an MPToken entry (has opted in to hold the token). */
    optedIn: boolean;
    /** Whether the issuer has approved (allowlisted) the holder. */
    authorized: boolean;
    /** Whether the holder's balance is individually locked. */
    frozen: boolean;
    balance: string;
    /** Amount held in escrow; must always be zero for this issuance. */
    lockedAmount: string;
    hasConfidentialBalance: boolean;
}
export interface BanReceipt {
    record: BanRecord;
    clawedBack: string;
    transactions: string[];
}
/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * Controls and how each is enforced:
 * - Allowlist: the issuance has Require Auth, so the ledger rejects any
 *   payment to or from a holder the issuer hasn't approved.
 * - Clawback: `Clawback` works on locked and unauthorized holders too.
 * - Ban: revoke approval, lock, claw back the whole balance, then re-read the
 *   ledger to confirm the holder holds nothing. The ban is recorded in the
 *   `BanRegistry` first, so an interrupted ban can be re-run safely and the
 *   address can never be approved again.
 * - Per-holder and global freeze: the ledger then blocks all holder-to-holder
 *   transfers involving the frozen balance. The ledger still lets the issuer
 *   pay a frozen holder, so `issue()` refuses to do that itself.
 *
 * Every method re-reads validated ledger state before acting and is
 * idempotent: repeating a call that already took effect does nothing.
 */
export declare class MptIssuer {
    private readonly deps;
    readonly issuanceId: string;
    readonly assetScale: number;
    private constructor();
    get issuerAddress(): string;
    /** Creates a new issuance with every compliance control enabled, and returns a manager for it. */
    static createIssuance(deps: IssuerDeps, options: CreateIssuanceOptions): Promise<MptIssuer>;
    /** Attaches to an existing issuance after checking that it is ours and has the required controls. */
    static load(deps: IssuerDeps, issuanceId: string): Promise<MptIssuer>;
    getIssuanceState(): Promise<IssuanceState>;
    getHolderState(holder: string): Promise<HolderState>;
    isBanned(holder: string): Promise<boolean>;
    /**
     * Approves a holder (after KYC) to hold the token. The holder must first opt
     * in by sending their own `MPTokenAuthorize`. Refuses banned addresses.
     */
    authorizeHolder(holder: string): Promise<TxOutcome | undefined>;
    /** Revokes a holder's approval. They can then neither send nor receive the token; their balance stays put. */
    revokeHolder(holder: string): Promise<TxOutcome | undefined>;
    /** Sends newly issued tokens to an approved, unfrozen holder. */
    issue(holder: string, amount: string): Promise<TxOutcome>;
    /**
     * Claws back `amount` (display units) from a holder, or their whole balance
     * with `'all'`. Refuses amounts above the balance rather than quietly
     * clawing back less. Returns the amount actually clawed back.
     */
    clawback(holder: string, amount: string | 'all'): Promise<{
        clawedBack: string;
        outcome: TxOutcome | undefined;
    }>;
    /** Freezes one holder: they can no longer send the token to, or receive it from, other holders. */
    freezeHolder(holder: string): Promise<TxOutcome | undefined>;
    /** Unfreezes one holder. A banned holder stays frozen. */
    unfreezeHolder(holder: string): Promise<TxOutcome | undefined>;
    /** Freezes all transfers of the token between holders, e.g. during an incident. */
    freezeAll(): Promise<TxOutcome | undefined>;
    /** Lifts a global freeze. Per-holder freezes stay in place. */
    unfreezeAll(): Promise<TxOutcome | undefined>;
    /**
     * Bans an address. When this resolves, the ledger shows the address holding
     * none of the token, unauthorized and frozen, and the registry will never
     * let it be approved again. If interrupted, call it again to finish.
     *
     * Steps, in order:
     * 1. Record the ban, so the address can't be re-approved even if a later step fails.
     * 2. Revoke approval. The ledger then rejects any payment to or from the holder.
     * 3. Freeze the holder.
     * 4. Claw back the entire balance.
     * 5. Re-read validated state and confirm steps 2-4 took effect.
     */
    ban(holder: string, reason: string): Promise<BanReceipt>;
    private submit;
    private readMPToken;
    private assertHolderAddress;
    private assertNotBanned;
}
