import { Client, type SubmittableTransaction as Transaction, type TransactionMetadata, type Wallet } from 'xrpl';
export interface Signer {
    readonly classicAddress: string;
    sign(tx: Transaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export interface Receipt {
    hash: string;
    ledger: number;
    code: string;
    meta: TransactionMetadata;
}
export declare class TransactionFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class UnresolvedTransaction extends Error {
    readonly hash: string;
    constructor(hash: string, options?: ErrorOptions);
}
/** Single writer, durable idempotency and signed-before-submit journal. Keep open per issuer. */
export declare class TransactionRunner {
    readonly client: Client;
    private readonly path;
    private readonly journal;
    private readonly release;
    private queue;
    private closed;
    private queued;
    constructor(client: Client, path: string);
    close(): void;
    exclusive<T>(work: () => Promise<T>): Promise<T>;
    isBanned(id: string, holder: string): boolean;
    hasOperation(key: string): boolean;
    markBanned(id: string, holder: string, reason: string): void;
    private persist;
    /** Call under exclusive(). Repeat the SAME key and intent after any timeout. */
    send(key: string, intent: Transaction, signer: Signer): Promise<Receipt>;
}
export declare function isRpcError(error: unknown, code: string): boolean;
