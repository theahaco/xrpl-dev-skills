import { Client, Wallet, type SubmittableTransaction as Transaction, type TransactionMetadata } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export declare function holderAddress(value: string, issuer: string): string;
export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    meta: TransactionMetadata;
}
export interface Prepared {
    hash: string;
    blob: string;
    lastLedgerSequence: number;
    transaction: Transaction;
}
/** Persist before submission. A pending transaction MUST be reconciled by hash before a new attempt. */
export interface Journal {
    prepared(record: Prepared): Promise<void>;
    validated(receipt: Receipt): Promise<void>;
}
/** Must be durable, shared across all issuer workers, and fail closed on storage errors. */
export interface BanStore {
    has(issuanceId: string, holder: string): Promise<boolean>;
    add(issuanceId: string, holder: string): Promise<void>;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class SubmissionUnknown extends Error {
    readonly hash: string;
    constructor(hash: string, options: ErrorOptions);
}
/** One instance per signing account; use an external account lock across processes. */
export declare class TransactionRunner {
    readonly client: Client;
    private readonly journal;
    private tail;
    private uncertain;
    constructor(client: Client, journal: Journal);
    assertTestnet(): Promise<void>;
    submit(wallet: Wallet, transaction: Transaction): Promise<Receipt>;
}
export declare class MptIssuer {
    readonly runner: TransactionRunner;
    private readonly wallet;
    readonly issuanceId: string;
    private readonly bans;
    private tail;
    constructor(runner: TransactionRunner, wallet: Wallet, issuanceId: string, bans: BanStore);
    static create(runner: TransactionRunner, wallet: Wallet, bans: BanStore): Promise<MptIssuer>;
    private serial;
    private holder;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holding(address: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    assertCapabilities(): Promise<void>;
    private allowed;
    private send;
    approve(address: string): Promise<void>;
    mint(address: string, value: string): Promise<void>;
    private lock;
    freeze(address: string): Promise<void>;
    unfreeze(address: string): Promise<void>;
    freezeAll(): Promise<void>;
    unfreezeAll(): Promise<void>;
    private claw;
    /** Ledger claws back min(requested, current balance); a zero balance fails. */
    clawback(address: string, value: string): Promise<void>;
    /** Durable intent -> revoke -> lock -> claw back -> verify. Safe to resume after partial completion. */
    ban(address: string): Promise<void>;
}
