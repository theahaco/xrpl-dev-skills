import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl';
export interface ValidatedTransaction {
    hash: string;
    /** Final result code from the validated ledger, e.g. `tesSUCCESS` or `tecLOCKED`. */
    resultCode: string;
    ledgerIndex: number;
    meta: TransactionMetadata;
}
export interface SubmitterOptions {
    /** Polling interval while waiting for validation. Default 1000 ms. */
    pollIntervalMs?: number;
    /**
     * How long to keep trying to learn the outcome while the connection is
     * failing before giving up with TransactionOutcomeUnknownError. Default 120 s.
     */
    outcomeTimeoutMs?: number;
}
/**
 * Signs and submits transactions and waits for a final, validated outcome.
 *
 * - Transactions from the same account are serialized, so concurrent callers
 *   can't race on the account Sequence.
 * - The transaction hash is known before submission, so a dropped connection
 *   leads to reconciliation by hash rather than a blind (double-spending) retry.
 * - "Not applied" is only concluded once a *validated* ledger has passed the
 *   transaction's LastLedgerSequence.
 */
export declare class TransactionSubmitter {
    private readonly client;
    private readonly queues;
    private readonly pollIntervalMs;
    private readonly outcomeTimeoutMs;
    constructor(client: Client, options?: SubmitterOptions);
    /** Submits and returns the validated outcome; throws TransactionFailedError unless tesSUCCESS. */
    submit(wallet: Wallet, tx: SubmittableTransaction): Promise<ValidatedTransaction>;
    /**
     * Submits and returns the validated outcome whatever its result code (tesSUCCESS or tec*).
     * Still throws for transactions that were never applied (tem/tef/tel, or expired).
     */
    submitForOutcome(wallet: Wallet, tx: SubmittableTransaction): Promise<ValidatedTransaction>;
    private serialized;
    private signSubmitAndWait;
    private waitForValidation;
    private lookupValidated;
}
