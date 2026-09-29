import { type Client, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';
export interface TxOutcome {
    hash: string;
    /** Engine result, e.g. `tesSUCCESS` or `tecLOCKED`. */
    result: string;
    ledgerIndex: number;
    meta: TransactionMetadata;
}
/**
 * Serializes async work. Transactions from one account must be signed in
 * order, or autofilled `Sequence` numbers collide.
 */
export declare class SerialQueue {
    private tail;
    run<T>(task: () => Promise<T>): Promise<T>;
}
/**
 * Autofills, signs and submits a transaction, then waits until it is in a
 * validated ledger. Returns the final outcome whether it succeeded or not.
 * Throws `TransactionFailedError` only if there is no final outcome: the
 * transaction was malformed (`tem`), rejected before being queued, or its
 * `LastLedgerSequence` passed without it being found. In the last case,
 * look up the hash before retrying.
 */
export declare function submitAndWaitForOutcome(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<TxOutcome>;
/** Like `submitAndWaitForOutcome`, but throws unless the result is `tesSUCCESS`. */
export declare function submitAndRequireSuccess(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<TxOutcome>;
/** Reads a ledger entry from the latest validated ledger; `undefined` if it doesn't exist. */
export declare function readValidatedEntry<T>(client: Client, selector: {
    mptoken: {
        mpt_issuance_id: string;
        account: string;
    };
} | {
    mpt_issuance: string;
}): Promise<T | undefined>;
/**
 * Checks that the connected server reports the given amendments as enabled.
 * Throws if any is disabled or unknown.
 */
export declare function assertAmendmentsEnabled(client: Client, names: readonly string[]): Promise<void>;
/** Returns the change in a holder's `MPTAmount` recorded in a transaction's metadata. */
export declare function mptBalanceDelta(meta: TransactionMetadata, issuanceId: string, holder: string): bigint;
