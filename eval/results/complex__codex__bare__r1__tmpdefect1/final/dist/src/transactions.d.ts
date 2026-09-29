import { Client, Wallet, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import { Store } from './store.js';
export interface Signer {
    readonly address: string;
    sign(transaction: SubmittableTransaction): Promise<{
        tx_blob: string;
        hash: string;
    }>;
}
export declare function walletSigner(wallet: Wallet): Signer;
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
export declare class Serial {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
/** A key is permanently bound to one intent. Persist signed bytes before sending. */
export declare class Transactions {
    readonly client: Client;
    readonly store: Store;
    private readonly serial;
    /** Shared by issuer instances to serialize multi-transaction compliance operations. */
    readonly complianceSerial: Serial;
    constructor(client: Client, store: Store);
    /** Read a completed outcome without executing it, with the same intent binding. */
    completed(key: string, tx: SubmittableTransaction): Receipt | undefined;
    checkTestnet(): Promise<void>;
    submit(key: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
    private accept;
}
