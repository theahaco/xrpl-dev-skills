import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'
import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors.js'

export interface ValidatedTransaction {
  hash: string
  /** Final result code from the validated ledger, e.g. `tesSUCCESS` or `tecLOCKED`. */
  resultCode: string
  ledgerIndex: number
  meta: TransactionMetadata
}

export interface SubmitterOptions {
  /** Polling interval while waiting for validation. Default 1000 ms. */
  pollIntervalMs?: number
  /**
   * How long to keep trying to learn the outcome while the connection is
   * failing before giving up with TransactionOutcomeUnknownError. Default 120 s.
   */
  outcomeTimeoutMs?: number
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
export class TransactionSubmitter {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly pollIntervalMs: number
  private readonly outcomeTimeoutMs: number

  constructor(
    private readonly client: Client,
    options: SubmitterOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 120_000
  }

  /** Submits and returns the validated outcome; throws TransactionFailedError unless tesSUCCESS. */
  async submit(wallet: Wallet, tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    const outcome = await this.submitForOutcome(wallet, tx)
    if (outcome.resultCode !== 'tesSUCCESS') {
      throw new TransactionFailedError(tx.TransactionType, outcome.resultCode, outcome.hash)
    }
    return outcome
  }

  /**
   * Submits and returns the validated outcome whatever its result code (tesSUCCESS or tec*).
   * Still throws for transactions that were never applied (tem/tef/tel, or expired).
   */
  async submitForOutcome(wallet: Wallet, tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    return this.serialized(wallet.classicAddress, () => this.signSubmitAndWait(wallet, tx))
  }

  private async serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    this.queues.set(key, run)
    try {
      return await run
    } finally {
      if (this.queues.get(key) === run) this.queues.delete(key)
    }
  }

  private async signSubmitAndWait(wallet: Wallet, tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    const prepared = await this.client.autofill({ ...tx, Account: wallet.classicAddress })
    const lastLedgerSequence = prepared.LastLedgerSequence
    if (lastLedgerSequence === undefined) {
      throw new Error('autofill did not set LastLedgerSequence; refusing to submit without an expiry')
    }
    const { tx_blob: txBlob, hash } = wallet.sign(prepared)

    let preliminary: string | undefined
    try {
      const response = await this.client.request({ command: 'submit', tx_blob: txBlob })
      preliminary = response.result.engine_result
    } catch {
      // The server may or may not have received it. Fall through to reconciliation by hash.
    }

    // tem/tef/tel: the transaction was rejected outright and can never be included in a ledger.
    if (preliminary !== undefined && /^(tem|tef|tel)/.test(preliminary)) {
      throw new TransactionFailedError(tx.TransactionType, preliminary, hash)
    }

    return this.waitForValidation(tx.TransactionType, hash, lastLedgerSequence)
  }

  private async waitForValidation(
    transactionType: string,
    hash: string,
    lastLedgerSequence: number,
  ): Promise<ValidatedTransaction> {
    let lastConnectivityOk = Date.now()
    let lastError: unknown
    for (;;) {
      await sleep(this.pollIntervalMs)
      try {
        const found = await this.lookupValidated(hash)
        if (found) return found
        const validatedIndex = await this.client.getLedgerIndex()
        if (validatedIndex > lastLedgerSequence) {
          // One final lookup closes the race between the two requests above.
          const lateFound = await this.lookupValidated(hash)
          if (lateFound) return lateFound
          throw new TransactionFailedError(transactionType, 'EXPIRED_NOT_APPLIED', hash)
        }
        lastConnectivityOk = Date.now()
      } catch (error) {
        if (error instanceof TransactionFailedError) throw error
        lastError = error
        if (Date.now() - lastConnectivityOk > this.outcomeTimeoutMs) {
          throw new TransactionOutcomeUnknownError(transactionType, hash, lastLedgerSequence, { cause: lastError })
        }
      }
    }
  }

  private async lookupValidated(hash: string): Promise<ValidatedTransaction | undefined> {
    try {
      const response = await this.client.request({ command: 'tx', transaction: hash })
      const { result } = response
      if (!result.validated || typeof result.meta !== 'object' || result.ledger_index === undefined) {
        return undefined
      }
      return { hash, resultCode: result.meta.TransactionResult, ledgerIndex: result.ledger_index, meta: result.meta }
    } catch (error) {
      if (isTxnNotFound(error)) return undefined
      throw error
    }
  }
}

function isTxnNotFound(error: unknown): boolean {
  const data = (error as { data?: { error?: unknown } } | undefined)?.data
  return data?.error === 'txnNotFound'
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
