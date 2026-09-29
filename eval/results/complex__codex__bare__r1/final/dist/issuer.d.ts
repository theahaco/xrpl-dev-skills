import type { LedgerEntry } from 'xrpl/dist/npm/models/ledger/index.js';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { Client, Wallet, type SubmittableTransaction as Transaction } from 'xrpl';
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export interface PolicyStore {
    isBanned(issuance: string, holder: string): Promise<boolean>;
    /** Must durably commit before resolving. Ban records must never be automatically removed. */
    ban(issuance: string, holder: string): Promise<void>;
}
export interface AuditEvent {
    phase: 'prepared' | 'validated';
    hash: string;
    transaction?: Transaction;
    blob?: string;
    result?: string;
    ledger?: number;
}
export type Audit = (event: AuditEvent) => Promise<void>;
export declare class LedgerFailure extends Error {
    readonly code: string;
    readonly hash: string;
    constructor(code: string, hash: string);
}
/** One runner per signing account; backend must additionally enforce a distributed single writer. */
export declare class TransactionRunner {
    readonly client: Client;
    private readonly audit;
    private tail;
    constructor(client: Client, audit: Audit);
    submit(wallet: Wallet, transaction: Transaction): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
}
export declare function objects(client: Client, account: string, ledger?: number | 'validated'): Promise<(LedgerEntry | MPToken)[]>;
export declare class MptIssuer {
    readonly runner: TransactionRunner;
    private readonly wallet;
    readonly issuanceId: string;
    private readonly policy;
    private tail;
    private constructor();
    static create(runner: TransactionRunner, wallet: Wallet, policy: PolicyStore): Promise<MptIssuer>;
    static attach(runner: TransactionRunner, wallet: Wallet, id: string, policy: PolicyStore): Promise<MptIssuer>;
    private serial;
    private holderAddress;
    private allowed;
    private send;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    approve(holder: string): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
    issue(holder: string, value: string): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
    private lock;
    freezeHolder(holder: string): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
    unfreezeHolder(holder: string): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
    freezeGlobal(): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
    unfreezeGlobal(): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
    private reclaim;
    clawback(holder: string, value: string): Promise<{
        hash: string;
        meta: unknown;
        ledger_index: number;
    }>;
    /** Resumable, non-atomic saga. Revocation prevents new receipts before the balance is read. */
    ban(holder: string): Promise<void>;
}
