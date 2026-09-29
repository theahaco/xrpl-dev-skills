import { Client, type SubmittableTransaction as Transaction, type Wallet, type TxResponse } from 'xrpl';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const MAX_AMOUNT = "9223372036854775807";
export declare const CONTROL_FLAGS: number;
export declare const AUTHORIZED = 2;
export declare const LOCKED = 1;
export declare function amount(value: string): string;
export declare function address(value: string): string;
export interface Signer {
    readonly classicAddress: string;
    sign(transaction: Transaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export interface PreparedRecord {
    hash: string;
    blob: string;
    lastLedgerSequence: number;
    transaction: Transaction;
}
export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
}
/** Writes must commit durably before resolving. Use a database outbox in a backend. */
export interface Journal {
    assertReady(account: string): Promise<void>;
    prepared(record: PreparedRecord): Promise<void>;
    settled(receipt: Receipt): Promise<void>;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class UncertainSubmission extends Error {
    readonly hash: string;
    readonly lastLedgerSequence: number;
    constructor(hash: string, lastLedgerSequence: number, options: ErrorOptions);
}
export declare class SerialQueue {
    private tail;
    run<T>(work: () => Promise<T>): Promise<T>;
}
/** Share per signing account; backend workers also need a distributed account lock. */
export declare class Executor {
    readonly client: Client;
    readonly signer: Signer;
    private readonly journal;
    private readonly queue;
    private uncertain;
    constructor(client: Client, signer: Signer, journal: Journal);
    send(tx: Transaction): Promise<TxResponse["result"]>;
}
export interface BanStore {
    isBanned(issuanceId: string, holder: string): Promise<boolean>;
    /** Persist intent BEFORE ledger transactions. No unban operation is exposed. */
    ban(issuanceId: string, holder: string): Promise<void>;
}
export interface HolderState {
    balance: string;
    authorized: boolean;
    frozen: boolean;
    exists: boolean;
}
export declare class MptIssuer {
    readonly executor: Executor;
    readonly issuanceId: string;
    private readonly bans;
    private readonly queue;
    private constructor();
    static create(executor: Executor, bans: BanStore): Promise<MptIssuer>;
    static open(executor: Executor, id: string, bans: BanStore): Promise<MptIssuer>;
    issuance(ledgerHash?: string): Promise<import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance>;
    private holderAddress;
    holder(holder: string, ledgerHash?: string): Promise<HolderState>;
    private allowed;
    private authorize;
    approve(holder: string): Promise<void>;
    mint(holder: string, value: string): Promise<void>;
    private lock;
    freeze(holder: string): Promise<void>;
    unfreeze(holder: string): Promise<void>;
    setGlobalFreeze(frozen: boolean): Promise<void>;
    private claw;
    /** Ledger caps clawback at current balance; zero balance is an error. */
    clawback(holder: string, value: string): Promise<void>;
    /** Resumable saga: intent, revoke, drain, verify. */
    ban(holder: string): Promise<void>;
}
