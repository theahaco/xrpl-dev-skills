import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'

import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors.js'

export interface TxReceipt {
  hash: string
  transactionType: string
  /** Validated ledger that contains the transaction. */
  ledgerIndex: number
  meta: TransactionMetadata
}

export interface SubmitterOptions {
  /** How often to poll for the transaction's outcome. Default 1000 ms. */
  pollIntervalMs?: number
  /** Consecutive network errors tolerated while polling before giving up. Default 10. */
  maxPollErrors?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function rippledErrorCode(err: unknown): { error?: string; searchedAll?: boolean } {
  const data = (err as { data?: { error?: unknown; searched_all?: unknown } } | undefined)?.data
  return {
    ...(typeof data?.error === 'string' ? { error: data.error } : {}),
    ...(typeof data?.searched_all === 'boolean' ? { searchedAll: data.searched_all } : {}),
  }
}

/**
 * Reliable transaction submission following the XRPL "reliable transaction
 * submission" pattern:
 *
 *  - Transactions from the same account are serialized, so concurrent callers
 *    in this process never race on the account Sequence.
 *  - Every transaction gets a LastLedgerSequence (via autofill), and the
 *    outcome is only reported once it is final: either the transaction is in a
 *    validated ledger, or a validated ledger past LastLedgerSequence exists and
 *    the server confirms (searched_all) that the transaction is not in any
 *    ledger in the window.
 *  - A non-tesSUCCESS final result throws TransactionFailedError. If finality
 *    cannot be proven, TransactionOutcomeUnknownError is thrown so the caller
 *    can reconcile by hash rather than blindly retrying.
 *
 * Note: only one process should sign for a given account at a time.
 */
export class TransactionSubmitter {
  readonly #client: Client
  readonly #pollIntervalMs: number
  readonly #maxPollErrors: number
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(client: Client, options: SubmitterOptions = {}) {
    this.#client = client
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000
    this.#maxPollErrors = options.maxPollErrors ?? 10
  }

  get client(): Client {
    return this.#client
  }

  /** Autofills, signs, submits and waits for a final outcome. Throws unless tesSUCCESS. */
  submit(wallet: Wallet, tx: SubmittableTransaction): Promise<TxReceipt> {
    const account = wallet.classicAddress
    const previous = this.#queues.get(account) ?? Promise.resolve()
    const run = previous.then(
      () => this.#submitNow(wallet, tx),
      () => this.#submitNow(wallet, tx),
    )
    const tail = run.catch(() => undefined)
    this.#queues.set(account, tail)
    void tail.then(() => {
      if (this.#queues.get(account) === tail) this.#queues.delete(account)
    })
    return run
  }

  async #submitNow(wallet: Wallet, tx: SubmittableTransaction): Promise<TxReceipt> {
    if (tx.Account !== wallet.classicAddress) {
      throw new Error(`Transaction Account ${tx.Account} does not match signing wallet`)
    }
    const client = this.#client
    const prepared = await client.autofill(tx)
    const lastLedgerSequence = prepared.LastLedgerSequence
    if (lastLedgerSequence === undefined) {
      throw new Error('autofill did not set LastLedgerSequence')
    }
    const { tx_blob: txBlob, hash } = wallet.sign(prepared)
    const type = tx.TransactionType
    const minLedger = await client.getLedgerIndex()

    const submitted = await client.request({ command: 'submit', tx_blob: txBlob })
    const prelim = submitted.result.engine_result
    // tem: malformed; tef: can never succeed (e.g. sequence already used);
    // tel: rejected by this server and not relayed. None can reach a ledger.
    if (/^(tem|tef|tel)/.test(prelim)) {
      throw new TransactionFailedError(prelim, hash, type, false, submitted.result.engine_result_message)
    }

    let pollErrors = 0
    for (;;) {
      await sleep(this.#pollIntervalMs)
      try {
        const found = await this.#lookup(hash)
        if (found && found !== 'searched-all-not-found') return this.#finalize(found, hash, type)

        const validatedIndex = await client.getLedgerIndex()
        if (validatedIndex > lastLedgerSequence) {
          const ranged = await this.#lookup(hash, minLedger, lastLedgerSequence)
          if (ranged === 'searched-all-not-found') {
            throw new TransactionFailedError(
              prelim,
              hash,
              type,
              false,
              `not included in any ledger up to LastLedgerSequence ${lastLedgerSequence}`,
            )
          }
          if (ranged) return this.#finalize(ranged, hash, type)
          throw new TransactionOutcomeUnknownError(
            hash,
            type,
            `LastLedgerSequence ${lastLedgerSequence} passed but server lacks full history for ledgers ${minLedger}-${lastLedgerSequence}`,
          )
        }
        pollErrors = 0
      } catch (err) {
        if (err instanceof TransactionFailedError || err instanceof TransactionOutcomeUnknownError) throw err
        pollErrors += 1
        if (pollErrors > this.#maxPollErrors) {
          throw new TransactionOutcomeUnknownError(hash, type, `polling failed repeatedly: ${String(err)}`)
        }
      }
    }
  }

  /**
   * Returns the validated transaction, `undefined` if not (yet) validated, or
   * 'searched-all-not-found' when a ranged lookup proves absence.
   */
  async #lookup(
    hash: string,
    minLedger?: number,
    maxLedger?: number,
  ): Promise<{ meta: TransactionMetadata; ledgerIndex: number } | 'searched-all-not-found' | undefined> {
    try {
      const res = await this.#client.request({
        command: 'tx',
        transaction: hash,
        ...(minLedger !== undefined && maxLedger !== undefined
          ? { min_ledger: minLedger, max_ledger: maxLedger }
          : {}),
      })
      const { meta, validated, ledger_index: ledgerIndex } = res.result
      if (validated && meta && typeof meta === 'object' && ledgerIndex !== undefined) {
        return { meta, ledgerIndex }
      }
      return undefined
    } catch (err) {
      const { error, searchedAll } = rippledErrorCode(err)
      if (error === 'txnNotFound') {
        return minLedger !== undefined && searchedAll === true ? 'searched-all-not-found' : undefined
      }
      throw err
    }
  }

  #finalize(found: { meta: TransactionMetadata; ledgerIndex: number }, hash: string, type: string): TxReceipt {
    const result = found.meta.TransactionResult
    if (result !== 'tesSUCCESS') {
      throw new TransactionFailedError(result, hash, type, true)
    }
    return { hash, transactionType: type, ledgerIndex: found.ledgerIndex, meta: found.meta }
  }
}
