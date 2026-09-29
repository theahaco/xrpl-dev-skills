import { Client, type SubmittableTransaction } from 'xrpl';
import { Store, type Receipt } from './store.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const AMENDMENTS = "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";
export interface Signer {
    readonly address: string;
    sign(tx: SubmittableTransaction): Promise<{
        tx_blob: string;
        hash: string;
    }> | {
        tx_blob: string;
        hash: string;
    };
}
export declare function rpcError(error: unknown, code: string): boolean;
export declare function checkTestnet(client: Client): Promise<unknown>;
export declare class TransactionFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class UncertainTransaction extends Error {
    readonly key: string;
    readonly hash: string;
    constructor(key: string, hash: string, options?: ErrorOptions);
}
/** All signing for an account must go through this single writer and journal. */
export declare class Ledger {
    readonly client: Client;
    readonly store: Store;
    private tail;
    constructor(client: Client, store: Store);
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
    /** Resolve an already-signed operation even if subsequent policy changes forbid a new one. */
    reconcile(key: string): Promise<Receipt>;
    /** Call under exclusive() when a workflow contains several transactions. */
    submit(key: string, signer: Signer, tx: SubmittableTransaction): Promise<Receipt>;
}
