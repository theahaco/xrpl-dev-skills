import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl';
import { dropsToXrp } from 'xrpl';
import {
  InvalidInputError,
  TransactionFailedError,
  TransactionNotAppliedError,
  TransactionOutcomeUnknownError,
} from './errors.js';

export interface SubmitterOptions {
  /** Validated ledgers the transaction may wait before it expires. Default 20 (~60-80 s). */
  ledgerOffset?: number;
  /** Refuse to sign if the auto-filled fee exceeds this many drops. Default 5000 (0.005 XRP). */
  maxFeeDrops?: number;
  /** Polling interval while waiting for validation. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Hard cap on how long to wait for a final outcome. Default 180 s. */
  timeoutMs?: number;
}

export interface SubmittedTransaction {
  hash: string;
  ledgerIndex: number;
  resultCode: 'tesSUCCESS';
  meta: TransactionMetadata;
}

export type Precheck = () => Promise<'skip' | void>;

const sleep =(ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Signs transactions locally and submits them with a reliable-submission loop.
 *
 * - The seed never leaves the process. Only the signed blob is sent.
 * - Transactions from one account go through a FIFO queue, so concurrent
 *   calls from the backend cannot race on the account's Sequence number.
 *   (If several processes share one signing account, put a single signing
 *   service in front of it. This queue only serializes within one process.)
 * - Every transaction gets a LastLedgerSequence. We only report "not applied"
 *   once a validated ledger past that bound exists and the server confirms
 *   that it searched the whole ledger range. Anything less certain is reported
 *   as {@link TransactionOutcomeUnknownError}.
 * - Resolves only for `tesSUCCESS` in a validated ledger. Everything else throws.
 */
export class TransactionSubmitter {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ledgerOffset: number;
  private readonly maxFeeDrops: number;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly client: Client,
    readonly wallet: Wallet,
    options: SubmitterOptions = {},
  ) {
    this.ledgerOffset = options.ledgerOffset ?? 20;
    this.maxFeeDrops = options.maxFeeDrops ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  get address(): string {
    return this.wallet.classicAddress;
  }

  submit(tx: SubmittableTransaction): Promise<SubmittedTransaction>;
  submit(tx: SubmittableTransaction, precheck: Precheck): Promise<SubmittedTransaction | null>;
  /**
   * Queue a transaction. If `precheck` is given, it runs inside the queue slot,
   * after every previously queued transaction has reached a final outcome and
   * immediately before signing. That makes check-then-act race-free within
   * this process. The precheck may throw to abort (nothing is signed), or
   * return 'skip' when the desired state already holds (resolves to null).
   */
  submit(tx: SubmittableTransaction, precheck?: Precheck): Promise<SubmittedTransaction | null> {
    if (tx.Account !== this.address) {
      return Promise.reject(
        new InvalidInputError(`Transaction Account ${tx.Account} does not match signer ${this.address}`),
      );
    }
    return this.enqueue(async () => {
      if (precheck && (await precheck()) === 'skip') return null;
      return this.submitOne(tx);
    });
  }

  /** Resolves once every transaction queued before this call has reached a final outcome. */
  barrier(): Promise<void> {
    return this.enqueue(async () => undefined);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    // Keep the queue alive regardless of this task's outcome.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async submitOne(tx: SubmittableTransaction): Promise<SubmittedTransaction> {
    const minLedger = await this.validatedLedgerIndex();
    const prepared = await this.client.autofill({
      ...tx,
      LastLedgerSequence: minLedger + this.ledgerOffset,
    });
    if (prepared.Fee === undefined || Number(prepared.Fee) > this.maxFeeDrops) {
      throw new TransactionNotAppliedError(
        `Refusing to sign ${tx.TransactionType}: fee ${prepared.Fee} drops exceeds cap of ${this.maxFeeDrops} drops (${dropsToXrp(this.maxFeeDrops)} XRP)`,
        undefined,
        undefined,
      );
    }
    const lastLedger = prepared.LastLedgerSequence as number;
    const { tx_blob, hash } = this.wallet.sign(prepared);

    // If the submit call itself errors, the blob may or may not have reached the
    // network. Fall through to polling, which determines the real outcome.
    const preliminary = await this.client
      .request({ command: 'submit', tx_blob })
      .then((response) => response.result.engine_result)
      .catch(() => undefined);

    // tem = malformed and tef = cannot ever succeed. Neither can be included in a ledger.
    if (preliminary?.startsWith('tem') || preliminary?.startsWith('tef')) {
      throw new TransactionNotAppliedError(
        `${tx.TransactionType} rejected before inclusion: ${preliminary}`,
        preliminary,
        hash,
      );
    }

    return this.waitForOutcome(tx.TransactionType, hash, minLedger, lastLedger);
  }

  private async waitForOutcome(
    type: string,
    hash: string,
    minLedger: number,
    lastLedger: number,
  ): Promise<SubmittedTransaction> {
    const deadline = Date.now() + this.timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      try {
        const response = await this.client.request({
          command: 'tx',
          transaction: hash,
          min_ledger: minLedger,
          max_ledger: lastLedger,
        });
        const result = response.result;
        if (result.validated === true && typeof result.meta === 'object' && result.meta !== null) {
          const meta = result.meta as TransactionMetadata;
          const ledgerIndex = result.ledger_index as number;
          if (meta.TransactionResult !== 'tesSUCCESS') {
            throw new TransactionFailedError(meta.TransactionResult, hash, ledgerIndex, type);
          }
          return { hash, ledgerIndex, resultCode: 'tesSUCCESS', meta };
        }
      } catch (error) {
        if (error instanceof TransactionFailedError) throw error;
        const data = (error as { data?: { error?: string; searched_all?: boolean } }).data;
        if (data?.error === 'txnNotFound') {
          if (data.searched_all === true && (await this.validatedLedgerIndex()) > lastLedger) {
            throw new TransactionNotAppliedError(
              `${type} ${hash} expired: not included by LastLedgerSequence ${lastLedger}`,
              undefined,
              hash,
            );
          }
        } else {
          lastError = error;
        }
      }
    }
    throw new TransactionOutcomeUnknownError(
      `Timed out determining outcome of ${type} ${hash}. Reconcile by hash before retrying.`,
      hash,
      lastLedger,
      { cause: lastError },
    );
  }

  private async validatedLedgerIndex(): Promise<number> {
    const response = await this.client.request({ command: 'ledger', ledger_index: 'validated' });
    return response.result.ledger_index;
  }
}
