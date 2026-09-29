import type { Client, SubmittableTransaction, TxResponse, Wallet } from "xrpl";
export declare class TransactionFailedError extends Error {
    readonly transactionType: string;
    readonly resultCode: string;
    readonly hash: string | undefined;
    constructor(transactionType: string, resultCode: string, hash: string | undefined);
}
/**
 * Autofills, signs, submits, and waits for validation of a transaction, then
 * throws unless the validated result is exactly `tesSUCCESS`.
 *
 * Never trusts the initial submission response alone — only a validated
 * ledger result is treated as final, per XRPL reliable-submission guidance.
 */
export declare function submitAndVerify<T extends SubmittableTransaction>(client: Client, wallet: Wallet, transaction: T): Promise<TxResponse<T>>;
