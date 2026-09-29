import { Client, type SubmittableTransaction, type Wallet } from 'xrpl';
import { FileStore, type Receipt } from './store.js';
export interface Signer {
    classicAddress: string;
    sign: (transaction: SubmittableTransaction) => ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export declare class TransactionRejected extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class SubmissionUncertain extends Error {
    readonly operationId: string;
    readonly hash: string;
    constructor(operationId: string, hash: string, cause: unknown);
}
/** Stable sorting makes idempotency independent of object property insertion order. */
export declare function fingerprint(value: unknown): string;
/** All issuer and demo holder transactions share one serialized, durable submission queue. */
export declare class Transactions {
    readonly client: Client;
    readonly store: FileStore;
    private tail;
    private operations;
    constructor(client: Client, store: FileStore);
    /** Serialize whole compliance workflows across all modules sharing this writer. */
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
    send(id: string, transaction: SubmittableTransaction, signer: Signer, before?: () => Promise<void>): Promise<Receipt>;
    private execute;
    private checked;
}
export declare function isRpcError(error: unknown, code: string): boolean;
