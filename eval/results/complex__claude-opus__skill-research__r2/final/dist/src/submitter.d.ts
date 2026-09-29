import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl';
export interface Logger {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
}
export declare const silentLogger: Logger;
export interface ValidatedTransaction {
    hash: string;
    ledgerIndex: number;
    meta: TransactionMetadata;
}
export interface SubmitterOptions {
    logger?: Logger;
    /** Delay between validation polls. Defaults to 1s (ledgers close every ~3-4s). */
    pollIntervalMs?: number;
}
/**
 * Signs and submits transactions for one account and waits for a final,
 * validated outcome.
 *
 * - Submissions are serialized, so concurrent callers never race on the
 *   account's Sequence number.
 * - Every transaction gets a LastLedgerSequence (via autofill). Once that
 *   ledger is validated without the transaction, it can never be applied,
 *   which is what makes failures final.
 * - Only `tesSUCCESS` in a validated ledger counts as success; anything else
 *   throws `TransactionFailedError`. If the outcome cannot be determined, it
 *   throws `TransactionOutcomeUnknownError` with the hash so the caller can
 *   reconcile before retrying.
 */
export declare class TransactionSubmitter {
    #private;
    constructor(client: Client, wallet: Wallet, options?: SubmitterOptions);
    get address(): string;
    submit(tx: SubmittableTransaction): Promise<ValidatedTransaction>;
}
