import { Client, Wallet, type SubmittableTransaction, type TransactionMetadata, type LedgerEntry } from 'xrpl';
type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    meta: TransactionMetadata;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export interface LedgerPort {
    send(key: string, tx: SubmittableTransaction): Promise<Receipt>;
    holding(id: string, holder: string): Promise<MPToken | undefined>;
    issuance(id: string): Promise<MPTokenIssuance>;
}
/** Owns a durable journal and a process lock. All use of an issuer must share this writer. */
export declare class TestnetLedger implements LedgerPort {
    readonly client: Client;
    private readonly issuer;
    private readonly directory;
    private tail;
    private closed;
    private constructor();
    static open(issuer: Wallet, directory: string): Promise<TestnetLedger>;
    close(): Promise<void>;
    send(key: string, tx: SubmittableTransaction): Promise<Receipt>;
    sendAs(key: string, tx: SubmittableTransaction, signer: Wallet): Promise<Receipt>;
    private submit;
    private reconcilePending;
    private settle;
    entry(request: {
        mptoken?: {
            mpt_issuance_id: string;
            account: string;
        };
        mpt_issuance?: string;
        ledger_index?: number | 'validated';
    }): Promise<LedgerEntry.MPToken | LedgerEntry.LedgerEntry>;
    holding(id: string, holder: string): Promise<MPToken | undefined>;
    issuance(id: string): Promise<MPTokenIssuance>;
}
export declare function isRpcError(error: unknown, code: string): boolean;
export {};
