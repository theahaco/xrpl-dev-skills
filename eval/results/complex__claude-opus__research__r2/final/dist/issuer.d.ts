import type { Client, MPTokenMetadata, Wallet } from 'xrpl';
import type { BanRegistry } from './banRegistry.js';
import type { ValidatedTransaction } from './submit.js';
/** Flags on an MPTokenIssuance ledger entry. */
export declare const IssuanceFlags: {
    readonly lsfMPTLocked: 1;
    readonly lsfMPTCanLock: 2;
    readonly lsfMPTRequireAuth: 4;
    readonly lsfMPTCanEscrow: 8;
    readonly lsfMPTCanTrade: 16;
    readonly lsfMPTCanTransfer: 32;
    readonly lsfMPTCanClawback: 64;
    readonly lsfMPTCanHoldConfidentialBalance: 128;
};
/** Flags on a holder's MPToken ledger entry. */
export declare const HolderFlags: {
    readonly lsfMPTLocked: 1;
    readonly lsfMPTAuthorized: 2;
};
export declare class ComplianceError extends Error {
    readonly name = "ComplianceError";
}
export interface TokenConfig {
    /** Decimal places the token supports. Amounts in this API are in display units. */
    assetScale: number;
    /** Optional supply cap, in display units. */
    maximumAmount?: string;
    /** Whether approved holders may pay each other. Payments always require both parties to be authorized. */
    transferable: boolean;
    /** Fee on holder-to-holder transfers, in units of 0.001% (0–50,000). Requires `transferable`. */
    transferFee?: number;
    /** XLS-89 metadata. */
    metadata: MPTokenMetadata;
}
export interface IssuerOptions {
    client: Client;
    /** The issuing account. It signs every transaction this module sends. */
    wallet: Wallet;
    banRegistry: BanRegistry;
    /** Called after every ledger-changing compliance action, for your audit log. */
    onAudit?: (event: AuditEvent) => void;
}
/**
 * Optional context for a compliance action. `reference` is written to the
 * public ledger as a memo, so it must be an opaque internal ID (such as a
 * case number) and never personal data or the reason itself.
 */
export interface ActionContext {
    reference?: string;
}
export interface BanContext extends ActionContext {
    /** Stored off-ledger in the ban registry only. */
    reason?: string;
}
export type AuditAction = 'create-issuance' | 'authorize-holder' | 'revoke-holder' | 'issue' | 'clawback' | 'freeze-holder' | 'unfreeze-holder' | 'freeze-all' | 'unfreeze-all' | 'ban';
export interface AuditEvent {
    action: AuditAction;
    issuanceId: string;
    holder?: string;
    /** Display units. */
    amount?: string;
    reference?: string;
    /**
     * The validated transaction that performed the action. Absent only for the
     * 'ban' event, which marks the registry write; the ledger steps of a ban
     * follow as their own events.
     */
    txHash?: string;
    ledgerIndex?: number;
}
export interface BanResult {
    state: HolderState;
    /** Ledger transactions this call submitted (empty if the ban was already complete). */
    transactions: ValidatedTransaction[];
}
export interface HolderState {
    address: string;
    /** Whether the holder has created an MPToken entry for this issuance. */
    optedIn: boolean;
    /** On the issuer's allowlist, i.e. the MPToken entry has lsfMPTAuthorized set. */
    authorized: boolean;
    /** Individually locked. The global lock is reported on IssuanceState. */
    frozen: boolean;
    banned: boolean;
    /** Display units. */
    balance: string;
    balanceUnits: bigint;
}
export interface IssuanceState {
    issuanceId: string;
    issuer: string;
    assetScale: number;
    globallyFrozen: boolean;
    canLock: boolean;
    requireAuth: boolean;
    canClawback: boolean;
    canTransfer: boolean;
    canEscrow: boolean;
    canTrade: boolean;
    /** Display units. */
    outstanding: string;
    maximumAmount: string | undefined;
    flags: number;
}
/**
 * Issuer-side controls for a regulated MPT.
 *
 * The issuance always has Require Auth (allowlist), Can Lock (per-holder and
 * global freeze) and Can Clawback set. Escrow, DEX trading and confidential
 * balances are always off, because each would let tokens move out of reach of
 * clawback. Since DynamicMPT is not enabled on the network, these flags cannot
 * be changed after creation.
 *
 * Transactions from one instance run one at a time, so account sequence
 * numbers never collide. Run at most one instance per issuing account.
 *
 * Every read uses the latest validated ledger. The pre-flight checks give
 * clear errors without spending a fee. The ledger still enforces every rule
 * on its own, so a check that goes stale only means the transaction fails.
 */
export declare class MptIssuer {
    private readonly options;
    readonly issuanceId: string;
    readonly assetScale: number;
    private queue;
    private constructor();
    get issuerAddress(): string;
    /** Create a new issuance with all compliance controls enabled. */
    static create(options: IssuerOptions, config: TokenConfig, context?: ActionContext): Promise<MptIssuer>;
    /**
     * Manage an existing issuance. Refuses issuances that aren't owned by the
     * wallet, or whose flags don't provide every compliance control.
     */
    static attach(options: IssuerOptions, issuanceId: string): Promise<MptIssuer>;
    /**
     * Put a holder on the allowlist after KYC. The holder must first opt in by
     * sending their own MPTokenAuthorize transaction; the ledger has nowhere to
     * record the authorization until then. Banned addresses are refused.
     */
    authorizeHolder(holder: string, context?: ActionContext): Promise<ValidatedTransaction | undefined>;
    /**
     * Remove a holder from the allowlist without banning them. They can no longer
     * receive the token. Any balance they hold stays put until you claw it back.
     */
    revokeHolder(holder: string, context?: ActionContext): Promise<ValidatedTransaction | undefined>;
    /** Mint `amount` (display units) to an approved holder. */
    issue(holder: string, amount: string, context?: ActionContext): Promise<ValidatedTransaction>;
    /**
     * Claw back up to `amount` (display units) from a holder. If the holder has
     * less, the ledger claws back their entire balance. Works whether or not the
     * holder is frozen or authorized. Returns the amount actually recovered.
     */
    clawback(holder: string, amount: string, context?: ActionContext): Promise<{
        clawedBack: string;
        tx: ValidatedTransaction;
    }>;
    /**
     * Freeze one holder so they can neither send nor receive the token.
     *
     * The ledger blocks every holder-to-holder payment to or from a frozen
     * holder (tecLOCKED). Payments between the holder and the issuer are
     * deliberately not blocked by the ledger, which leads to two cases:
     *  - issuer → frozen holder: the ledger allows it, so this module refuses
     *    to issue to a frozen holder. Don't bypass the module to pay one.
     *  - frozen holder → issuer (redemption/burn): allowed; tokens only leave
     *    circulation this way.
     * Clawback still works on a frozen holder.
     */
    freezeHolder(holder: string, context?: ActionContext): Promise<ValidatedTransaction | undefined>;
    unfreezeHolder(holder: string, context?: ActionContext): Promise<ValidatedTransaction | undefined>;
    /**
     * Freeze all movement of the token: every holder-to-holder payment fails
     * with tecLOCKED. As with per-holder freezes, the ledger doesn't block
     * issuance, so this module refuses to issue while globally frozen.
     * Redemptions to the issuer and clawback remain possible. Per-holder
     * freezes are independent and survive a global unfreeze.
     */
    freezeAll(context?: ActionContext): Promise<ValidatedTransaction | undefined>;
    unfreezeAll(context?: ActionContext): Promise<ValidatedTransaction | undefined>;
    /**
     * Ban an address permanently:
     *  1. record the ban in the registry, so the address can never be
     *     authorized again (this happens first, so a crash mid-way fails safe);
     *  2. freeze it, so it can't move its balance to other holders before the
     *     clawback lands;
     *  3. remove it from the allowlist. This is the lasting barrier: the lock
     *     is not, because while fixCleanup3_4_0 is off a zero-balance holder
     *     can delete a locked MPToken and opt in again. The new entry is
     *     unauthorized, so the address still can't receive anything;
     *  4. claw back its entire balance.
     *
     * Idempotent: calling it again finishes any steps that didn't complete.
     * Resolves only once the validated ledger shows a zero balance and no
     * authorization.
     */
    ban(holder: string, context?: BanContext): Promise<BanResult>;
    getHolder(holder: string): Promise<HolderState>;
    getIssuance(): Promise<IssuanceState>;
    private revokeUnlocked;
    private clawbackUnlocked;
    private setHolderLock;
    private setGlobalLock;
    private holderStateUnlocked;
    private submit;
    private audit;
    private serialize;
    private assertHolderAddress;
    private fetchIssuanceEntry;
    private fetchHolderToken;
}
