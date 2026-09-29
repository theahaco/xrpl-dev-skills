import { setTimeout as sleep } from 'node:timers/promises'

import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'

import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors.js'

const MAX_CONSECUTIVE_POLL_ERRORS = 5

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
}

export interface ValidatedTransaction {
  hash: string
  ledgerIndex: number
  meta: TransactionMetadata
}

export interface SubmitterOptions {
  logger?: Logger
  /** Delay between validation polls. Defaults to 1s (ledgers close every ~3-4s). */
  pollIntervalMs?: number
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
export class TransactionSubmitter {
  readonly #client: Client
  readonly #wallet: Wallet
  readonly #logger: Logger
  readonly #pollIntervalMs: number
  #queue: Promise<unknown> = Promise.resolve()

  constructor(client: Client, wallet: Wallet, options: SubmitterOptions = {}) {
    this.#client = client
    this.#wallet = wallet
    this.#logger = options.logger ?? silentLogger
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000
  }

  get address(): string {
    return this.#wallet.classicAddress
  }

  submit(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    const run = this.#queue.then(() => this.#submitOne(tx))
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #submitOne(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    if (tx.Account !== this.#wallet.classicAddress) {
      throw new Error(
        `Refusing to sign ${tx.TransactionType} for ${tx.Account} with the key of ${this.#wallet.classicAddress}`,
      )
    }
    const prepared = await this.#client.autofill(tx)
    const lastLedgerSequence = prepared.LastLedgerSequence
    if (lastLedgerSequence === undefined) {
      throw new Error('autofill did not set LastLedgerSequence; refusing to submit')
    }
    const { tx_blob: txBlob, hash } = this.#wallet.sign(prepared)
    const type = tx.TransactionType

    const submitted = await this.#client.request({ command: 'submit', tx_blob: txBlob })
    const preliminary = submitted.result.engine_result
    this.#logger.info('tx.submitted', { type, hash, preliminary, sequence: prepared.Sequence })

    // tem (malformed) and tef (failed, e.g. past sequence) results can never
    // be applied later. tel/ter results are provisional, so we wait for the
    // final outcome like we do for tes/tec.
    if (preliminary.startsWith('tem') || preliminary.startsWith('tef')) {
      throw new TransactionFailedError(
        type,
        preliminary,
        hash,
        `${type} rejected: ${preliminary} (${submitted.result.engine_result_message})`,
        false,
      )
    }

    const outcome = await this.#waitForValidation(type, hash, lastLedgerSequence, preliminary)
    const result = outcome.meta.TransactionResult
    if (result !== 'tesSUCCESS') {
      this.#logger.warn('tx.failed', { type, hash, result, ledgerIndex: outcome.ledgerIndex })
      throw new TransactionFailedError(
        type,
        result,
        hash,
        `${type} failed in validated ledger ${outcome.ledgerIndex}: ${result}`,
        true,
      )
    }
    this.#logger.info('tx.validated', { type, hash, result, ledgerIndex: outcome.ledgerIndex })
    return outcome
  }

  async #waitForValidation(
    type: string,
    hash: string,
    lastLedgerSequence: number,
    preliminary: string,
  ): Promise<ValidatedTransaction> {
    let consecutiveErrors = 0
    for (;;) {
      await sleep(this.#pollIntervalMs)
      try {
        const response = await this.#client
          .request({ command: 'tx', transaction: hash })
          .catch((error: unknown) => {
            if ((error as { data?: { error?: string } }).data?.error === 'txnNotFound') {
              return undefined
            }
            throw error
          })
        consecutiveErrors = 0
        if (response?.result.validated === true) {
          const meta = response.result.meta
          const ledgerIndex = response.result.ledger_index
          if (typeof meta !== 'object' || ledgerIndex === undefined) {
            throw new Error(`Validated response for ${hash} is missing metadata`)
          }
          return { hash, ledgerIndex, meta }
        }
        const validatedLedger = await this.#client.getLedgerIndex()
        if (validatedLedger > lastLedgerSequence) {
          // Re-check once: the tx may have been validated in the ledger we
          // just learned about, between the two requests above.
          const recheck = await this.#client
            .request({ command: 'tx', transaction: hash })
            .catch(() => undefined)
          if (recheck?.result.validated === true && typeof recheck.result.meta === 'object') {
            return { hash, ledgerIndex: recheck.result.ledger_index ?? validatedLedger, meta: recheck.result.meta }
          }
          throw new TransactionFailedError(
            type,
            preliminary,
            hash,
            `${type} expired: not included by LastLedgerSequence ${lastLedgerSequence} (preliminary ${preliminary})`,
            false,
          )
        }
      } catch (error) {
        if (error instanceof TransactionFailedError) {
          throw error
        }
        consecutiveErrors += 1
        this.#logger.warn('tx.poll_error', { type, hash, attempt: consecutiveErrors, error: String(error) })
        if (consecutiveErrors < MAX_CONSECUTIVE_POLL_ERRORS) {
          continue
        }
        throw new TransactionOutcomeUnknownError(
          type,
          hash,
          lastLedgerSequence,
          `Could not determine the outcome of ${type} ${hash}; reconcile before retrying`,
          { cause: error },
        )
      }
    }
  }
}
