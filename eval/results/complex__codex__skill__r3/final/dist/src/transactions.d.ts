import { Client, type SubmittableTransaction, type Wallet } from 'xrpl';
import { SerialQueue, type Receipt, type StateStore } from './state.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export interface Signer {
    readonly classicAddress: string;
    sign(transaction: SubmittableTransaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare function rpcError(error: unknown, code: string): boolean;
/** IDs are durable idempotency keys. Never replace an uncertain transaction with a new ID. */
export declare class TransactionRunner {
    readonly client: Client;
    readonly store: StateStore;
    private readonly queue;
    readonly workflows: SerialQueue;
    private constructor();
    static testnet(client: Client, store: StateStore): Promise<TransactionRunner>;
    send(id: string, transaction: SubmittableTransaction, signer: Signer): Promise<Receipt>;
}
