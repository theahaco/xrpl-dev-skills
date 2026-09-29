import { Client, type SubmittableTransaction as Transaction } from 'xrpl';
import { type Store } from './store.js';
export interface Signer {
    readonly address: string;
    sign(tx: Transaction): Promise<{
        tx_blob: string;
        hash: string;
    }> | {
        tx_blob: string;
        hash: string;
    };
}
export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    issuanceId?: string;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class UnresolvedTransaction extends Error {
    readonly hash: string;
    constructor(hash: string, options?: ErrorOptions);
}
export interface Submitter {
    readonly address: string;
    execute(key: string, tx: Transaction): Promise<Receipt>;
}
/** One shared runner per account. Durable idempotency keys must never be recycled. */
export declare class TransactionRunner implements Submitter {
    private readonly client;
    private readonly signer;
    private readonly store;
    private readonly maxFeeDrops;
    private readonly queue;
    readonly address: string;
    constructor(client: Client, signer: Signer, store: Store, maxFeeDrops?: bigint);
    execute(key: string, tx: Transaction): Promise<Receipt>;
}
