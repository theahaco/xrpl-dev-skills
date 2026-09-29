import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { Transactions, type Signer, type Receipt } from './transactions.js';
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export declare function holderAddress(value: string, issuer: string): string;
export interface HolderState {
    balance: string;
    authorized: boolean;
    frozen: boolean;
    exists: boolean;
}
/** KYC decisions happen upstream. Only trusted compliance services may call approve. */
export declare class MptIssuer {
    readonly transactions: Transactions;
    private readonly signer;
    readonly issuanceId: string;
    private get serial();
    private constructor();
    static create(transactions: Transactions, signer: Signer, operationId: string, maximumAmount?: string, assetScale?: number): Promise<MptIssuer>;
    static open(transactions: Transactions, signer: Signer, id: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(holder: string, ledger?: number | 'validated'): Promise<HolderState>;
    private banKey;
    private ensureNotBanned;
    private send;
    approve(holder: string, operationId: string): Promise<Receipt>;
    mint(holder: string, value: string, operationId: string): Promise<Receipt>;
    clawback(holder: string, value: string, operationId: string): Promise<Receipt>;
    private clawbackInternal;
    freezeHolder(holder: string, frozen: boolean, operationId: string): Promise<Receipt>;
    freezeAll(frozen: boolean, operationId: string): Promise<Receipt>;
    private lock;
    /** Resumable saga, not atomic: persist intent, revoke, lock, drain, verify. */
    ban(holder: string): Promise<HolderState>;
}
