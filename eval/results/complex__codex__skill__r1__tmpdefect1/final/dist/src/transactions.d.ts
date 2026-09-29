import { Client, Wallet, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import type { Store } from './store.js';
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
/** One instance per issuer worker, shared by every operation (including funding). */
export declare class Transactions {
    readonly client: Client;
    readonly store: Store;
    private tail;
    constructor(client: Client, store: Store);
    /** Reconcile a previously broadcast operation without constructing a replacement. */
    resumePending(wallet: Wallet): Promise<Receipt | undefined>;
    submit(id: string, tx: SubmittableTransaction, wallet: Wallet): Promise<Receipt>;
    private execute;
}
