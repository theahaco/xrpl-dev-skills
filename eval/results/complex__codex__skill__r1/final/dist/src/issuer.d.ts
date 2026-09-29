import type { Store } from './store.js';
import { Transactions, type Signer } from './transactions.js';
export interface MPToken {
    LedgerEntryType: 'MPToken';
    MPTAmount: string;
    Flags: number;
}
export interface MPTokenIssuance {
    LedgerEntryType: 'MPTokenIssuance';
    Issuer: string;
    Flags: number;
    OutstandingAmount: string;
    DomainID?: string;
    TransferFee?: number;
}
export declare const CAPABILITIES: number;
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare function amount(value: string): string;
export declare function holderAddress(address: string, issuer: string): string;
export declare class MptIssuer {
    readonly transactions: Transactions;
    private readonly signer;
    readonly issuanceId: string;
    private readonly store;
    private tail;
    private serial;
    constructor(transactions: Transactions, signer: Signer, issuanceId: string, store: Store);
    static create(transactions: Transactions, signer: Signer, store: Store, operationId: string): Promise<MptIssuer>;
    private holder;
    private banKey;
    private notBanned;
    private send;
    issuance(ledgerHash?: string): Promise<MPTokenIssuance>;
    holding(holder: string, ledgerHash?: string): Promise<MPToken | undefined>;
    assertCapabilities(): Promise<void>;
    approve(id: string, holder: string): Promise<import("./transactions.js").Receipt>;
    revoke(id: string, holder: string): Promise<import("./transactions.js").Receipt>;
    private authorize;
    mint(id: string, holder: string, value: string): Promise<import("./transactions.js").Receipt>;
    clawback(id: string, holder: string, value: string): Promise<import("./transactions.js").Receipt>;
    freeze(id: string, holder: string, frozen: boolean): Promise<import("./transactions.js").Receipt>;
    globalFreeze(id: string, frozen: boolean): Promise<import("./transactions.js").Receipt>;
    ban(id: string, holder: string): Promise<void>;
    private mintInternal;
    private clawbackInternal;
    private freezeInternal;
    private globalFreezeInternal;
    /** Resumable, fail-closed workflow. Not an atomic ledger operation. Call with the same ID on retry. */
    private banInternal;
}
