import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare const CONTROL_FLAGS: number;
export declare function amount(value: string): string;
/** rippled omits default-valued fields despite the SDK declaring MPTAmount required. */
export declare function normalizeHolding(node: MPToken): MPToken;
export interface Receipt {
    hash: string;
    ledger: number;
    code: string;
}
export interface Journal {
    /** Persist before broadcast; a pending entry must block new submissions until reconciled. */
    prepared(hash: string, blob: string, lastLedger: number): Promise<void>;
    validated(receipt: Receipt): Promise<void>;
}
export declare class TransactionFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
/** One instance per signing account, with an exclusive external lock across processes. */
export declare class Submitter {
    readonly client: Client;
    readonly wallet: Wallet;
    private readonly journal;
    private tail;
    private uncertain;
    constructor(client: Client, wallet: Wallet, journal: Journal);
    submit(tx: SubmittableTransaction): Promise<Receipt>;
}
export interface BanStore {
    has(issuanceId: string, holder: string): Promise<boolean>;
    /** Durably record intent before any ledger action. No automatic unban. */
    add(issuanceId: string, holder: string): Promise<void>;
}
export declare class Issuer {
    readonly submitter: Submitter;
    readonly issuanceId: string;
    private readonly bans;
    private tail;
    constructor(submitter: Submitter, issuanceId: string, bans: BanStore);
    static create(submitter: Submitter): Promise<string>;
    private exclusive;
    private holder;
    private permitted;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holding(holder: string, ledger?: number | 'validated'): Promise<MPToken | null>;
    verifyConfiguration(): Promise<void>;
    private authorize;
    approve(holder: string): Promise<Receipt>;
    mint(holder: string, value: string): Promise<Receipt>;
    private lock;
    freezeHolder(holder: string, frozen?: boolean): Promise<Receipt>;
    freezeAll(frozen?: boolean): Promise<Receipt>;
    private claw;
    /** XRPL clamps an amount exceeding the current balance to that balance. */
    clawback(holder: string, value: string): Promise<Receipt>;
    /** Resumable, not atomic. Revocation blocks incoming funds before balance removal. */
    ban(holder: string): Promise<void>;
}
