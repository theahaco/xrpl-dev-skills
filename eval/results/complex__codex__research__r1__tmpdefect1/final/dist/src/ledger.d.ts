import { Client, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';
import { FileStore } from './store.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const AMENDMENTS_INDEX = "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";
export declare const REQUIRED_AMENDMENTS: {
    MPTokensV1: string;
    Clawback: string;
};
export interface Signer {
    readonly address: string;
    sign(transaction: SubmittableTransaction): Promise<{
        tx_blob: string;
        hash: string;
    }>;
}
export declare const walletSigner: (wallet: Wallet) => Signer;
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
export declare function requireSuccess(receipt: Receipt): Receipt;
/** Fail-closed, idempotent submission. Never signs a replacement for an ambiguous transaction. */
export declare class TransactionRunner {
    readonly client: Client;
    private readonly store;
    private readonly queue;
    private readonly journal;
    constructor(client: Client, store: FileStore);
    hasOperation(key: string): boolean;
    preflight(): Promise<void>;
    submit(key: string, transaction: SubmittableTransaction, signer: Signer): Promise<Receipt>;
    private finish;
}
export declare function isRpcError(error: unknown, code: string): boolean;
