import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl';
import { RippledError } from 'xrpl';

import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors.js';

export interface SubmittedTransaction {
  transactionType: string;
  hash: string;
  ledgerIndex: number;
  resultCode: string;
  meta: TransactionMetadata;
}

/** How often to poll for the transaction while waiting for validation. */
const POLL_INTERVAL_MS = 1_000;
/** Ledgers to keep waiting past LastLedgerSequence when the server cannot search all history. */
const INCONCLUSIVE_LEDGER_MARGIN = 10;

/**
 * Signs and submits transactions for one account and waits for their final
 * outcome. Submissions from the same instance are serialized so concurrent
 * callers never race on the account's Sequence number.
 *
 * Every transaction carries a LastLedgerSequence (set by autofill), so its
 * outcome is always final once that ledger is validated. This class decides
 * the outcome itself by looking the hash up with `tx`, rather than relying on
 * the wall-clock/ledger race inside `Client.submitAndWait`.
 */
export class TransactionSubmitter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly wallet: Wallet,
  ) {}

  get address(): string {
    return this.wallet.classicAddress;
  }

  /**
   * Submits `tx` and resolves once it is validated with `tesSUCCESS`.
   * @throws TransactionFailedError if the transaction definitively did not succeed.
   * @throws TransactionOutcomeUnknownError if the outcome could not be determined.
   */
  submit<T extends SubmittableTransaction>(tx: T): Promise<SubmittedTransaction> {
    const run = this.queue.then(() => this.submitNow(tx));
    // Keep the queue alive regardless of this submission's outcome.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Submits `tx` expecting the ledger to reject it with a `tec` code and
   * resolves with that result. Used to prove the ledger itself enforces a
   * control. Throws if the transaction unexpectedly succeeds.
   */
  async submitExpectingFailure<T extends SubmittableTransaction>(tx: T): Promise<SubmittedTransaction> {
    let success: SubmittedTransaction;
    try {
      success = await this.submit(tx);
    } catch (error) {
      if (error instanceof TransactionFailedError && error.validated) {
        return {
          transactionType: error.transactionType,
          hash: error.hash,
          resultCode: error.resultCode,
          ...error.validated,
        };
      }
      throw error;
    }
    throw new Error(`${tx.TransactionType} ${success.hash} unexpectedly succeeded`);
  }

  private async submitNow<T extends SubmittableTransaction>(tx: T): Promise<SubmittedTransaction> {
    const prepared = await this.client.autofill({ ...tx, Account: this.wallet.classicAddress });
    const lastLedger = prepared.LastLedgerSequence;
    if (lastLedger === undefined) throw new Error('autofill did not set LastLedgerSequence');
    const signed = this.wallet.sign(prepared);
    const firstLedger = await this.client.getLedgerIndex();

    let preliminary: string;
    try {
      const response = await this.client.request({ command: 'submit', tx_blob: signed.tx_blob });
      preliminary = response.result.engine_result;
    } catch (error) {
      // The request may or may not have reached the server; reconcile below.
      preliminary = `unknown (${error instanceof Error ? error.message : String(error)})`;
    }
    // `tem` codes mean the transaction is malformed and can never be applied.
    if (preliminary.startsWith('tem')) {
      throw new TransactionFailedError(tx.TransactionType, preliminary, signed.hash);
    }

    try {
      return await this.waitForOutcome(tx.TransactionType, signed.hash, firstLedger, lastLedger, preliminary);
    } catch (error) {
      if (error instanceof TransactionFailedError) throw error;
      throw new TransactionOutcomeUnknownError(tx.TransactionType, signed.hash, lastLedger, { cause: error });
    }
  }

  private async waitForOutcome(
    transactionType: string,
    hash: string,
    firstLedger: number,
    lastLedger: number,
    preliminary: string,
  ): Promise<SubmittedTransaction> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const lookup = await this.lookup(hash, firstLedger, lastLedger);

      if (lookup.kind === 'validated') {
        if (lookup.result.resultCode !== 'tesSUCCESS') {
          throw new TransactionFailedError(transactionType, lookup.result.resultCode, hash, {
            ledgerIndex: lookup.result.ledgerIndex,
            meta: lookup.result.meta,
          });
        }
        return { ...lookup.result, transactionType };
      }
      // Not yet validated. Once LastLedgerSequence is validated, a transaction
      // that is not in the searched range can never be included.
      if (lookup.kind === 'pending') continue;
      const validatedLedger = await this.client.getLedgerIndex();
      if (validatedLedger <= lastLedger) continue;
      // Re-check: the transaction may have been validated between the lookup and now.
      const recheck = await this.lookup(hash, firstLedger, lastLedger);
      if (recheck.kind === 'validated') continue; // handled on the next iteration
      if (recheck.kind === 'not-found' && recheck.searchedAll) {
        throw new TransactionFailedError(
          transactionType,
          'EXPIRED',
          hash,
          undefined,
          `not included in any ledger up to LastLedgerSequence ${lastLedger} (preliminary result ${preliminary})`,
        );
      }
      if (validatedLedger > lastLedger + INCONCLUSIVE_LEDGER_MARGIN) {
        throw new Error(`Server cannot confirm whether ${hash} was included (incomplete ledger history)`);
      }
    }
  }

  private async lookup(
    hash: string,
    minLedger: number,
    maxLedger: number,
  ): Promise<
    | { kind: 'validated'; result: Omit<SubmittedTransaction, 'transactionType'> }
    | { kind: 'pending' }
    | { kind: 'not-found'; searchedAll: boolean }
  > {
    try {
      const response = await this.client.request({
        command: 'tx',
        transaction: hash,
        min_ledger: minLedger,
        max_ledger: maxLedger,
      });
      const { validated, meta, ledger_index: ledgerIndex } = response.result;
      if (!validated) return { kind: 'pending' };
      if (typeof meta !== 'object' || ledgerIndex === undefined) {
        throw new Error(`Validated transaction ${hash} is missing metadata or ledger_index`);
      }
      return {
        kind: 'validated',
        result: { hash, ledgerIndex, resultCode: meta.TransactionResult, meta: meta as TransactionMetadata },
      };
    } catch (error) {
      if (error instanceof RippledError) {
        const data = error.data as { error?: string; searched_all?: boolean } | undefined;
        if (data?.error === 'txnNotFound') return { kind: 'not-found', searchedAll: data.searched_all === true };
      }
      throw error;
    }
  }
}
