import {
  RippledError,
  type Client,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl'

import {
  TransactionExpiredError,
  TransactionFailedError,
  TransactionOutcomeUnknownError,
} from './errors.js'

/** A transaction that reached a validated ledger with `tesSUCCESS`. */
export interface ValidatedTransaction {
  hash: string
  ledgerIndex: number
  meta: TransactionMetadata
}

export interface SubmitterOptions {
  /** How often to poll for the transaction outcome. Default 1000 ms. */
  pollIntervalMs?: number
  /**
   * Upper bound on how long to keep trying to determine the outcome after
   * submission (covers reconnects). Default 180 000 ms, well beyond the
   * ~20-ledger LastLedgerSequence window that `autofill` sets.
   */
  outcomeTimeoutMs?: number
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Signs and submits transactions for one account and waits for a final,
 * validated outcome.
 *
 * - Submissions are serialised, so concurrent callers never race for the same
 *   account Sequence number.
 * - Success means "validated with tesSUCCESS", never just "accepted by the
 *   server". Every other outcome is reported as a typed error carrying the hash:
 *   {@link TransactionFailedError}, {@link TransactionExpiredError} (proven
 *   never to apply) or {@link TransactionOutcomeUnknownError} (look it up
 *   before retrying).
 *
 * Only one Submitter (in one process) should sign for a given account at a
 * time. Otherwise Sequence numbers collide.
 */
export class Submitter {
  readonly address: string
  private readonly client: Client
  private readonly wallet: Wallet
  private readonly pollIntervalMs: number
  private readonly outcomeTimeoutMs: number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(client: Client, wallet: Wallet, options: SubmitterOptions = {}) {
    this.client = client
    this.wallet = wallet
    this.address = wallet.classicAddress
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 180_000
  }

  /**
   * Runs `fn` exclusively with respect to every other `exclusive`/`submit`
   * call on this Submitter. Use it to make "check ledger state, then submit"
   * sequences atomic with respect to this process.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    // Keep the chain alive regardless of this task's outcome.
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Autofills, signs and submits `tx`, then waits for it to be validated.
   * Must be called either outside `exclusive` or from inside the function
   * passed to it via {@link submitUnlocked}; calling `submit` from inside
   * `exclusive` would deadlock.
   */
  async submit(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    return this.exclusive(async () => this.submitUnlocked(tx))
  }

  /** Same as {@link submit}, for use inside an {@link exclusive} section. */
  async submitUnlocked(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    if (tx.Account !== this.address) {
      throw new Error(`Submitter for ${this.address} cannot sign for ${tx.Account}`)
    }
    const prepared = await this.client.autofill(tx)
    const lastLedgerSequence = prepared.LastLedgerSequence
    if (lastLedgerSequence === undefined) {
      // autofill always sets it; refuse to submit a transaction that could
      // linger forever and make the outcome undecidable.
      throw new Error('autofill did not set LastLedgerSequence')
    }
    const { tx_blob: txBlob, hash } = this.wallet.sign(prepared)
    const type = prepared.TransactionType
    // Validated ledger just before submission: the earliest ledger the
    // transaction could possibly land in is the one after this.
    const minLedger = await this.client.getLedgerIndex()

    try {
      const response = await this.client.request({ command: 'submit', tx_blob: txBlob })
      const engineResult = response.result.engine_result
      // tem: malformed, can never apply. tef: failed and not relayed; the
      // sequence/ledger window makes it impossible to apply. tefALREADY means
      // an identical tx is already queued/applied, so keep waiting for it.
      if (
        engineResult.startsWith('tem') ||
        (engineResult.startsWith('tef') && engineResult !== 'tefALREADY')
      ) {
        throw new TransactionFailedError(type, engineResult, hash)
      }
    } catch (error) {
      if (error instanceof TransactionFailedError) {
        throw error
      }
      // The request may or may not have reached the server. Fall through and
      // determine the outcome from the ledger by hash.
    }

    return this.waitForOutcome(type, hash, minLedger, lastLedgerSequence)
  }

  private async waitForOutcome(
    type: string,
    hash: string,
    minLedger: number,
    lastLedgerSequence: number,
  ): Promise<ValidatedTransaction> {
    const deadline = Date.now() + this.outcomeTimeoutMs
    let lastError: unknown

    while (Date.now() < deadline) {
      try {
        const response = await this.client.request({ command: 'tx', transaction: hash })
        const { result } = response
        if (result.validated === true && typeof result.meta === 'object') {
          const meta = result.meta
          const ledgerIndex = result.ledger_index ?? 0
          if (meta.TransactionResult !== 'tesSUCCESS') {
            throw new TransactionFailedError(type, meta.TransactionResult, hash, ledgerIndex)
          }
          return { hash, ledgerIndex, meta }
        }
      } catch (error) {
        if (error instanceof TransactionFailedError) {
          throw error
        }
        if (!isTxnNotFound(error)) {
          lastError = error
        }
      }

      try {
        const validated = await this.client.getLedgerIndex()
        if (validated > lastLedgerSequence) {
          // Past the deadline ledger: prove it was never included by asking
          // the server to search the whole window it could have landed in.
          if (await this.provenAbsent(hash, minLedger + 1, lastLedgerSequence)) {
            throw new TransactionExpiredError(type, hash, lastLedgerSequence)
          }
        }
      } catch (error) {
        if (error instanceof TransactionExpiredError) {
          throw error
        }
        lastError = error
      }

      await sleep(this.pollIntervalMs)
    }

    throw new TransactionOutcomeUnknownError(type, hash, lastError)
  }

  /** True only if the server confirms it searched every ledger in range. */
  private async provenAbsent(hash: string, minLedger: number, maxLedger: number): Promise<boolean> {
    try {
      await this.client.request({
        command: 'tx',
        transaction: hash,
        min_ledger: minLedger,
        max_ledger: maxLedger,
      })
      // Found after all; the caller's next poll reports its outcome.
      return false
    } catch (error) {
      return isTxnNotFound(error) && searchedAll(error)
    }
  }
}

function errorData(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof RippledError && typeof error.data === 'object' && error.data !== null) {
    return error.data as Record<string, unknown>
  }
  return undefined
}

function isTxnNotFound(error: unknown): boolean {
  return errorData(error)?.['error'] === 'txnNotFound'
}

function searchedAll(error: unknown): boolean {
  const data = errorData(error)
  if (data === undefined) {
    return false
  }
  const nested = data['result']
  return (
    data['searched_all'] === true ||
    (typeof nested === 'object' &&
      nested !== null &&
      (nested as Record<string, unknown>)['searched_all'] === true)
  )
}
