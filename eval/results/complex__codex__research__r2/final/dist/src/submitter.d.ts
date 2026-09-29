import { Client, Wallet } from 'xrpl';
import type { SubmittableTransaction } from 'xrpl';
import { Store } from './store.js';
import type { Receipt } from './store.js';
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare function canonical(value: unknown): string;
export declare function rpcCode(error: unknown): string | undefined;
/** Stable operation IDs provide at-most-once submission, including after crashes. */
export declare class Submitter {
    readonly client: Client;
    readonly store: Store;
    private tail;
    constructor(client: Client, store: Store);
    exclusive<T>(work: () => Promise<T>): Promise<T>;
    send(id: string, tx: SubmittableTransaction, signer: Wallet): Promise<Receipt>;
    private check;
}
