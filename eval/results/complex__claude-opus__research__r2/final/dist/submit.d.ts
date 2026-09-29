import type { Client, SubmittableTransaction, TransactionMetadata, TxResponse, Wallet } from 'xrpl';
/**
 * Thrown when a transaction was validated with a result other than tesSUCCESS
 * (for example a `tec` code). The fee was spent, but nothing else changed.
 */
export declare class TransactionFailedError extends Error {
    readonly transactionType: string;
    readonly resultCode: string;
    readonly hash: string;
    readonly ledgerIndex: number | undefined;
    readonly name = "TransactionFailedError";
    constructor(transactionType: string, resultCode: string, hash: string, ledgerIndex: number | undefined);
}
/**
 * Thrown when a transaction was rejected before it could reach a ledger
 * (tem/tef/tel codes, or it expired unvalidated). The ledger was not changed.
 */
export declare class TransactionRejectedError extends Error {
    readonly transactionType: string;
    readonly resultCode: string;
    readonly hash: string;
    readonly name = "TransactionRejectedError";
    constructor(transactionType: string, resultCode: string, hash: string, message: string);
}
export interface ValidatedTransaction {
    hash: string;
    ledgerIndex: number;
    meta: TransactionMetadata;
    response: TxResponse;
}
/**
 * Autofill, sign, submit and wait for a transaction to reach a final outcome.
 *
 * Resolves only if the transaction is in a validated ledger with tesSUCCESS.
 * Rejects with TransactionFailedError when it is validated with another result,
 * and with TransactionRejectedError once it provably can never be validated:
 * either it was rejected outright, or a validated ledger has passed its
 * LastLedgerSequence without including it.
 */
export declare function submitAndConfirm(client: Client, wallet: Wallet, transaction: SubmittableTransaction): Promise<ValidatedTransaction>;
/** Extract the rippled error code from an xrpl.js request error, if any. */
export declare function errorCode(error: unknown): string | undefined;
