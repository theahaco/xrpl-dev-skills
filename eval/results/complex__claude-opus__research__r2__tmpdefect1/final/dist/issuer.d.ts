import { type Client, type MPTokenMetadata, type Wallet } from 'xrpl';
import type { BanRecord, BanRegistry } from './banRegistry.js';
/** Issuance capabilities the compliance controls depend on. */
export declare const REQUIRED_ISSUANCE_FLAGS: number;
/**
 * Capabilities this module refuses to work with, because each one lets value sit
 * where the standard Clawback transaction can't reach it or where the allowlist
 * doesn't apply. With any of them, a ban could no longer guarantee a zero balance.
 *  - CanEscrow: escrowed balances (LockedAmount) can't be clawed back.
 *  - CanHoldConfidentialBalance: encrypted balances need ConfidentialMPTClawback.
 *  - CanTrade: DEX/AMM positions live in offers or pseudo-accounts.
 */
export declare const FORBIDDEN_ISSUANCE_FLAGS: number;
export interface CreateIssuanceOptions {
    /** Decimal places of the token. For example, 2 means 1 token = 100 base units. */
    assetScale: number;
    /** Supply cap in token units. Defaults to the ledger maximum. */
    maximumAmount?: string;
    /** XLS-89 metadata, encoded on-ledger (max 1024 bytes). */
    metadata?: MPTokenMetadata;
    /**
     * Whether approved holders may pay each other (tfMPTCanTransfer). If false, holders
     * can only transact with the issuer. Defaults to true. The DynamicMPT amendment isn't
     * enabled on testnet or mainnet, so this can't be changed after creation.
     */
    allowHolderTransfers?: boolean;
    /** Transfer fee in units of 0.001% (0 to 50000). Needs allowHolderTransfers. */
    transferFee?: number;
}
export interface MptIssuerOptions {
    client: Client;
    /** The issuer's signing wallet. */
    wallet: Wallet;
    banRegistry: BanRegistry;
    /** Refuse to sign unless connected to this network (1 = testnet, 0 = mainnet). */
    expectedNetworkId: number;
    /** Called after every ledger-changing compliance action; wire this to your audit log. */
    onAudit?: (event: AuditEvent) => void;
}
export interface AuditEvent {
    action: string;
    issuanceId: string;
    holder?: string;
    amount?: string;
    txHash?: string;
    ledgerIndex?: number;
    detail?: string;
}
export type Outcome = {
    status: 'submitted';
    hash: string;
    ledgerIndex: number;
} | {
    status: 'noop';
    reason: string;
};
export interface HolderStatus {
    address: string;
    /** Whether the holder has an MPToken entry (has opted in to hold the token). */
    optedIn: boolean;
    approved: boolean;
    frozen: boolean;
    banned: boolean;
    /** Balance in token units. */
    balance: string;
    /** Balance in integer base units, as stored on-ledger. */
    balanceBaseUnits: bigint;
}
export interface IssuanceStatus {
    issuanceId: string;
    issuer: string;
    assetScale: number;
    globallyFrozen: boolean;
    outstanding: string;
    maximum: string;
    flags: number;
}
export interface BanReport {
    address: string;
    record: BanRecord;
    steps: Array<{
        step: 'freeze' | 'revoke-approval' | 'clawback';
        outcome: Outcome;
        amount?: string;
    }>;
    finalStatus: HolderStatus;
}
/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * All ledger-changing methods are serialized per instance, so concurrent calls from
 * your backend can't collide on account Sequence numbers. Run at most one instance
 * per issuer account; for more, use Tickets or an external lock.
 */
export declare class MptIssuer {
    #private;
    readonly issuanceId: string;
    readonly assetScale: number;
    private constructor();
    /** Creates a new issuance with every compliance control enabled and returns an issuer for it. */
    static createIssuance(options: MptIssuerOptions, params: CreateIssuanceOptions): Promise<MptIssuer>;
    /** Attaches to an existing issuance after checking that the controls are available. */
    static open(options: MptIssuerOptions, issuanceId: string): Promise<MptIssuer>;
    /**
     * Adds a KYC-approved holder to the allowlist. The holder must first opt in by
     * submitting their own MPTokenAuthorize transaction.
     */
    approveHolder(address: string): Promise<Outcome>;
    /**
     * Removes a holder from the allowlist. They can no longer send or receive the
     * token, but keep their current balance. Use {@link ban} to also zero the balance
     * and block re-approval.
     */
    revokeApproval(address: string): Promise<Outcome>;
    /** Sends newly issued tokens to an approved, unfrozen holder. */
    issue(address: string, amount: string): Promise<Outcome>;
    /**
     * Claws back exactly `amount` from a holder. Fails if the holder's balance is
     * smaller; use {@link clawbackAll} to take whatever they hold.
     */
    clawback(address: string, amount: string): Promise<Outcome & {
        clawedBack?: string;
    }>;
    /** Claws back a holder's entire balance in one transaction, even if it changes in flight. */
    clawbackAll(address: string): Promise<Outcome & {
        clawedBack?: string;
    }>;
    /**
     * Freezes one holder. On the ledger, a frozen holder can't send to or receive from
     * other holders. This module also refuses to issue to them. The ledger still lets a
     * frozen holder send tokens back to the issuer (redemption), and the issuer can
     * always claw back.
     */
    freezeHolder(address: string): Promise<Outcome>;
    unfreezeHolder(address: string): Promise<Outcome>;
    /** Freezes all transfers between holders, and all issuance through this module. */
    freezeAll(): Promise<Outcome>;
    unfreezeAll(): Promise<Outcome>;
    /**
     * Bans an address permanently.
     *
     * 1. Records the ban durably, so {@link approveHolder} refuses the address from now on.
     * 2. Freezes the holder, so they can't send to or receive from other holders.
     * 3. Revokes approval, so the ledger itself rejects any payment to or from them.
     * 4. Claws back the full balance.
     * 5. Re-reads the ledger and checks the holder has zero balance and no approval.
     *
     * Idempotent: a partly completed ban can be finished by calling it again.
     */
    ban(address: string, reason: string): Promise<BanReport>;
    isBanned(address: string): Promise<boolean>;
    getHolderStatus(address: string): Promise<HolderStatus>;
    getIssuanceStatus(): Promise<IssuanceStatus>;
}
