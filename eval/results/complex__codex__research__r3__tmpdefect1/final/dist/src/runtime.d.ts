import { Client, type SubmittableTransaction, type TxResponse, type Wallet } from 'xrpl';
export declare const ENDPOINT = "wss://s.altnet.rippletest.net:51233";
export declare function readJson<T>(path: string): Promise<T | undefined>;
export declare function writeJson(path: string, value: unknown): Promise<void>;
export declare function rpcError(e: unknown, code: string): boolean;
export interface Signer {
    readonly classicAddress: string;
    sign(tx: SubmittableTransaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export declare class LedgerFailure extends Error {
    readonly code: string;
    readonly hash: string;
    constructor(code: string, hash: string);
}
/** One exclusive runtime per issuer. All workflows must use run(). No automatic re-signing. */
export declare class Runtime {
    readonly client: Client;
    readonly directory: string;
    private tail;
    private journal;
    private constructor();
    static open(directory: string): Promise<Runtime>;
    checkNetwork(): Promise<void>;
    run<T>(work: () => Promise<T>): Promise<T>;
    close(): Promise<void>;
    private save;
    audit(): unknown[];
    /** Resolve saved bytes, never replace a timed-out payment with a new transaction. */
    reconcilePending(): Promise<void>;
    /** Call inside run(); id is a stable business operation ID, never reused for different intent. */
    send(id: string, tx: SubmittableTransaction, signer: Signer): Promise<TxResponse>;
}
