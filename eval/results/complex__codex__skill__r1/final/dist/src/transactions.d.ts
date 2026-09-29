import { Client, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';
import type { Store } from './store.js';
export interface Signer {
    readonly classicAddress: string;
    sign(tx: SubmittableTransaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
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
export declare class UncertainSubmission extends Error {
    readonly hash: string;
    constructor(hash: string, options?: ErrorOptions);
}
/** Serializes one process. Backend must also hold an exclusive distributed issuer lock. */
export declare class Transactions {
    readonly client: Client;
    private readonly store;
    private tail;
    constructor(client: Client, store: Store);
    submit(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
    private execute;
}
