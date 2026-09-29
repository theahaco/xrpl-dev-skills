import { setTimeout as sleep } from 'node:timers/promises'
import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'

import { OutcomeUnknownError, TransactionFailedError } from './errors.js'
import type { Logger } from './logger.js'

export interface ValidatedTransaction {
  hash: string
  ledgerIndex: number
  engineResult: 'tesSUCCESS'
  meta: TransactionMetadata
}

export interface SubmitterOptions {
  /** How many ledgers the transaction stays valid for. Default 20 (~1 minute). */
  ledgerWindow?: number
  /** Poll interval while waiting for validation. Default 1000 ms. */
  pollIntervalMs?: number
  /**
   * How long to keep trying to learn the outcome if the network misbehaves
   * after submission, before giving up with OutcomeUnknownError. Default 180 s.
   */
  outcomeTimeoutMs?: number
}

/**
 * Signs and submits transactions for a single account, one at a time.
 *
 * Every transaction ends in exactly one of these ways:
 *  - resolves with a validated tesSUCCESS result,
 *  - throws TransactionFailedError when it definitively did not succeed,
 *  - throws OutcomeUnknownError when we could not find out.
 *
 * Submissions are serialized in-process so sequence numbers never collide.
 * Run a single writer per issuing account. Several processes sharing one
 * key will race on sequence numbers.
 */
export class TransactionSubmitter {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly ledgerWindow: number
  private readonly pollIntervalMs: number
  private readonly outcomeTimeoutMs: number

  constructor(
    private readonly client: Client,
    readonly wallet: Wallet,
    private readonly logger: Logger,
    options: SubmitterOptions = {},
  ) {
    this.ledgerWindow = options.ledgerWindow ?? 20
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 180_000
  }

  submit(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    const run = this.queue.then(() => this.submitNow(tx))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async submitNow(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    if (tx.Account !== this.wallet.classicAddress) {
      throw new Error(`Transaction account ${tx.Account} does not match signer ${this.wallet.classicAddress}`)
    }
    const prepared = await this.client.autofill(tx)
    const current = await this.client.getLedgerIndex()
    prepared.LastLedgerSequence = current + this.ledgerWindow
    const lastLedger = prepared.LastLedgerSequence

    const { tx_blob: blob, hash } = this.wallet.sign(prepared)
    const type = tx.TransactionType
    this.logger.debug?.(`submitting ${type} ${hash}`, { lastLedger })

    let preliminary: string
    try {
      const response = await this.client.request({ command: 'submit', tx_blob: blob })
      preliminary = response.result.engine_result
      // Only tem (malformed) is final on its own. Any other preliminary result,
      // tec/tef/tel/ter included, can still differ from the final outcome, so
      // we wait for a validated ledger or for LastLedgerSequence to pass.
      if (preliminary.startsWith('tem')) {
        throw new TransactionFailedError(type, hash, preliminary, response.result.engine_result_message)
      }
    } catch (error) {
      if (error instanceof TransactionFailedError) throw error
      // The submit call itself failed (e.g. a dropped connection). The blob may
      // or may not have reached the network, so find out the same way.
      this.logger.warn?.(`submit of ${type} ${hash} errored; checking whether it landed`, { error: String(error) })
      preliminary = 'UNKNOWN'
    }

    return this.awaitOutcome(type, hash, lastLedger, preliminary)
  }

  private async awaitOutcome(
    type: string,
    hash: string,
    lastLedger: number,
    preliminary: string,
  ): Promise<ValidatedTransaction> {
    const deadline = Date.now() + this.outcomeTimeoutMs
    let lastError: unknown
    for (;;) {
      try {
        // Read the validated ledger index BEFORE looking the tx up. If the tx is
        // missing and that ledger is already past LastLedgerSequence, it can
        // never be included.
        const validatedIndex = await this.client.getLedgerIndex()
        const found = await this.lookup(hash)
        if (found !== undefined) {
          const result = found.meta.TransactionResult
          if (result !== 'tesSUCCESS') throw new TransactionFailedError(type, hash, result)
          return { hash, ledgerIndex: found.ledgerIndex, engineResult: 'tesSUCCESS', meta: found.meta }
        }
        if (validatedIndex > lastLedger) {
          throw new TransactionFailedError(type, hash, 'EXPIRED', `not validated by ledger ${lastLedger}; preliminary ${preliminary}`)
        }
      } catch (error) {
        if (error instanceof TransactionFailedError) throw error
        lastError = error
        this.logger.warn?.(`error while awaiting ${type} ${hash}; retrying`, { error: String(error) })
      }
      if (Date.now() > deadline) throw new OutcomeUnknownError(type, hash, lastLedger, { cause: lastError })
      await sleep(this.pollIntervalMs)
    }
  }

  private async lookup(hash: string): Promise<{ ledgerIndex: number; meta: TransactionMetadata } | undefined> {
    try {
      const response = await this.client.request({ command: 'tx', transaction: hash })
      const { result } = response
      if (!result.validated || result.ledger_index === undefined) return undefined
      if (typeof result.meta !== 'object') throw new Error(`tx ${hash} returned no JSON metadata`)
      return { ledgerIndex: result.ledger_index, meta: result.meta }
    } catch (error) {
      if (isRippledError(error, 'txnNotFound')) return undefined
      throw error
    }
  }
}

export function isRippledError(error: unknown, code: string): boolean {
  const data = (error as { data?: { error?: unknown } } | null)?.data
  return data?.error === code
}
