import { Client, type SubmittableTransaction as Transaction, type TransactionMetadata, type Wallet } from 'xrpl';
import { Store } from './store.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export interface Signer {
    readonly classicAddress: string;
    sign(transaction: Transaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export interface Receipt {
    hash: string;
    ledger: number;
    code: string;
    meta: TransactionMetadata;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class ExpiredTransaction extends Error {
    readonly hash: string;
    constructor(hash: string);
}
export declare class PendingTransaction extends Error {
    readonly hash: string;
    readonly lastLedger: number;
    constructor(hash: string, lastLedger: number, options?: ErrorOptions);
}
export declare function preflight(client: Client): Promise<void>;
/** One instance, one writer process per issuer. The service owns the durable store. */
export declare class Ledger {
    readonly client: Client;
    readonly store: Store;
    private tail;
    constructor(client: Client, store: Store);
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
    /** Call within exclusive(). IDs must be stable across caller retries. Never auto-resign uncertain transactions. */
    send(id: string, tx: Transaction, signer: Signer): Promise<Receipt>;
    private success;
}
