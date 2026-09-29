import { Client, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import { type Store } from './store.js';
export declare const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
export declare function validateOperationId(id: string): void;
export interface Signer {
    readonly address: string;
    sign(transaction: SubmittableTransaction): {
        tx_blob: string;
        hash: string;
    } | Promise<{
        tx_blob: string;
        hash: string;
    }>;
}
export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    metadata: TransactionMetadata;
}
export declare class TransactionFailed extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class OutcomeUnknown extends Error {
    readonly hash: string;
    constructor(hash: string, cause: unknown);
}
/** Share one executor for all callers using this issuer; it owns account sequence allocation. */
export declare class LedgerExecutor {
    readonly client: Client;
    readonly store: Store;
    private tail;
    constructor(client: Client, store: Store);
    checkNetwork(): Promise<void>;
    exclusive<T>(work: () => Promise<T>): Promise<T>;
    execute(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
    /** Reconcile the durable pending transaction before restarting a composite operation. */
    reconcilePending(): Promise<Receipt | undefined>;
    /** Used inside exclusive() by composite issuer operations. */
    transact(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
}
export declare function requireSuccess(receipt: Receipt): Receipt;
