import { type Client, type MPTokenMetadata, type Wallet } from 'xrpl';
import type { BanRecord, BanRegistry } from './banRegistry.js';
import type { TransactionSubmitter } from './submit.js';
export interface IssuanceConfig {
    /** Decimal places of the token, e.g. 2 means 1 token = 100 base units. Cannot be changed later. */
    assetScale: number;
    /** XLS-89 metadata. Validated strictly, and cannot be changed later without the DynamicMPT amendment. */
    metadata: MPTokenMetadata;
    /** Optional supply cap, in token units (e.g. "1000000.00"). */
    maximumAmount?: string;
    /**
     * Allow holder-to-holder transfers (tfMPTCanTransfer). Default true. If
     * false, holders can only send the token back to the issuer.
     */
    allowHolderTransfers?: boolean;
}
export interface IssuanceState {
    issuanceId: string;
    issuer: string;
    assetScale: number;
    outstanding: string;
    maximumAmount: string | undefined;
    globallyFrozen: boolean;
    capabilities: {
        requireAuth: boolean;
        canLock: boolean;
        canClawback: boolean;
        canTransfer: boolean;
        canEscrow: boolean;
        canTrade: boolean;
    };
}
export interface HolderState {
    address: string;
    /** Whether the holder has opted in (an MPToken entry exists). */
    optedIn: boolean;
    /** On the issuer's allowlist (lsfMPTAuthorized). */
    approved: boolean;
    /** Individually frozen (lsfMPTLocked on the holder's MPToken). */
    frozen: boolean;
    /** Recorded as banned in the ban registry. */
    banned: boolean;
    balance: string;
    balanceBaseUnits: bigint;
}
export type AuditAction = 'create_issuance' | 'approve' | 'revoke_approval' | 'issue' | 'clawback' | 'freeze_holder' | 'unfreeze_holder' | 'freeze_all' | 'unfreeze_all' | 'ban';
export interface AuditEvent {
    at: string;
    issuanceId: string;
    action: AuditAction;
    holder?: string;
    amount?: string;
    txHash?: string;
    reason?: string;
    detail?: string;
}
export interface MptIssuerDeps {
    client: Client;
    submitter: TransactionSubmitter;
    banRegistry: BanRegistry;
    /** Receives one event per compliance action applied on ledger. Wire this to your audit log. */
    onAudit?: (event: AuditEvent) => void;
}
export interface ActionResult {
    /** False if the ledger was already in the requested state and nothing was submitted. */
    changed: boolean;
    txHash?: string;
}
export interface ClawbackResult extends ActionResult {
    clawedBack: string;
}
export interface BanResult {
    address: string;
    txHashes: string[];
    clawedBack: string;
    record: BanRecord;
}
/**
 * Issuer-side compliance controls for one MPT issuance: allowlist, issuance,
 * clawback, bans, per-holder freeze and global freeze.
 *
 * Every mutating call checks the validated ledger state first and runs
 * exclusively (one at a time per instance), so a check can't be invalidated by
 * a concurrent call from the same process. Run a single instance per issuance;
 * across processes, use an external lock.
 */
export declare class MptIssuer {
    private readonly deps;
    private readonly wallet;
    readonly issuanceId: string;
    readonly assetScale: number;
    private exclusiveChain;
    private constructor();
    /**
     * Creates a new issuance with allowlisting, locking and clawback enabled.
     * Escrow and DEX trading are deliberately not enabled: clawback can't reach
     * escrowed balances, and neither feature is needed for the controls here.
     */
    static create(deps: MptIssuerDeps, wallet: Wallet, config: IssuanceConfig): Promise<MptIssuer>;
    /** Attaches to an existing issuance after checking that `wallet` issued it and that all controls are enabled. */
    static load(deps: MptIssuerDeps, wallet: Wallet, issuanceId: string): Promise<MptIssuer>;
    get issuerAddress(): string;
    getIssuanceState(): Promise<IssuanceState>;
    getHolderState(address: string): Promise<HolderState>;
    /** Adds a KYC-approved holder to the allowlist. The holder must have opted in first. */
    approveHolder(address: string, reason?: string): Promise<ActionResult>;
    /**
     * Removes a holder from the allowlist. They keep any balance but can neither
     * send nor receive the token until re-approved. Use `ban` to also remove the balance.
     */
    revokeApproval(address: string, reason?: string): Promise<ActionResult>;
    /**
     * Issues (mints) `amount` tokens to an approved holder. Refuses to issue to
     * holders that are banned, not approved or frozen, and while the token is
     * globally frozen. The ledger itself lets an issuer pay a frozen holder, so
     * this check is what keeps frozen holders from receiving.
     */
    issue(address: string, amount: string, reason?: string): Promise<ActionResult>;
    /**
     * Claws back `amount` tokens (or the whole balance with "all") from any
     * holder, whether or not they are frozen or approved. If `amount` is more
     * than the balance, the whole balance is clawed back. The result reports the
     * amount actually removed, read from the transaction metadata.
     */
    clawback(address: string, amount: string | 'all', reason?: string): Promise<ClawbackResult>;
    /** Freezes one holder: they can no longer send to or receive from other holders. */
    freezeHolder(address: string, reason?: string): Promise<ActionResult>;
    unfreezeHolder(address: string, reason?: string): Promise<ActionResult>;
    /** Freezes all transfers between holders. Issuance also stops (enforced by this module). */
    freezeAll(reason?: string): Promise<ActionResult>;
    unfreezeAll(reason?: string): Promise<ActionResult>;
    /**
     * Bans an address permanently. The steps:
     *   1. Record the ban durably, so the address can never be re-approved.
     *   2. Freeze the holder, so nothing moves while the ban is carried out.
     *   3. Remove them from the allowlist. The ledger then rejects any payment to them.
     *   4. Claw back their entire balance.
     *   5. Re-read the validated ledger to confirm: zero balance, not approved.
     * Safe to call again; completed steps are skipped, so a ban interrupted
     * partway through can be finished by calling this again.
     */
    ban(address: string, reason: string): Promise<BanResult>;
    private requireOptedIn;
    private setHolderLock;
    private unauthorize;
    private clawbackUnits;
    private submit;
    private exclusive;
    private assertHolderAddress;
    private audit;
}
