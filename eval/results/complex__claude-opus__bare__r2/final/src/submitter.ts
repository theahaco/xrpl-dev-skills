import { type Client, type SubmittableTransaction, type TransactionMetadata, type Wallet, ValidationError, XrplError, validate } from 'xrpl'

import { TransactionExpiredError, TransactionFailedError } from './errors.js'
import { type Logger, silentLogger } from './logger.js'

export interface SubmitResult {
  hash: string
  resultCode: string
  ledgerIndex: number
  meta: TransactionMetadata
}

export interface SubmitOptions {
  /**
   * Runs inside the submission queue immediately before the transaction is
   * prepared. Throw to abort. Because it is serialised with every other
   * transaction from this submitter, state it checks cannot be changed by
   * another of this submitter's transactions before this one is signed.
   */
  precheck?: () => Promise<void>
}

export interface SubmitterOptions {
  logger?: Logger
  /** How many ledgers a transaction may take to validate before it is considered expired. */
  ledgerWindow?: number
  /** Poll interval while waiting for validation. */
  pollIntervalMs?: number
}

const DEFAULT_LEDGER_WINDOW = 20
const DEFAULT_POLL_INTERVAL_MS = 1_000

/**
 * Signs and submits transactions for a single account, one at a time, and
 * waits for a final validated outcome.
 *
 * Transactions are serialised per submitter so concurrent callers can never
 * race on the account's Sequence number. Every transaction carries a
 * LastLedgerSequence, so its outcome is always final: either it is found in a
 * validated ledger, or the window passes and it provably can never apply.
 */
export class TransactionSubmitter {
  private readonly client: Client
  private readonly wallet: Wallet
  private readonly logger: Logger
  private readonly ledgerWindow: number
  private readonly pollIntervalMs: number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(client: Client, wallet: Wallet, options: SubmitterOptions = {}) {
    this.client = client
    this.wallet = wallet
    this.logger = options.logger ?? silentLogger
    this.ledgerWindow = options.ledgerWindow ?? DEFAULT_LEDGER_WINDOW
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  get address(): string {
    return this.wallet.classicAddress
  }

  /** Submits and throws TransactionFailedError unless the result is tesSUCCESS. */
  async submit(tx: SubmittableTransaction, options: SubmitOptions = {}): Promise<SubmitResult> {
    const result = await this.submitAllowingFailure(tx, options)
    if (result.resultCode !== 'tesSUCCESS') {
      throw new TransactionFailedError(tx.TransactionType, result.hash, result.resultCode, true)
    }
    return result
  }

  /**
   * Submits and returns the validated outcome even when it is a tec-class
   * failure. Still throws if the transaction can never be applied.
   */
  submitAllowingFailure(tx: SubmittableTransaction, options: SubmitOptions = {}): Promise<SubmitResult> {
    const run = this.queue.then(async () => {
      await options.precheck?.()
      return this.submitNow(tx)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async submitNow(tx: SubmittableTransaction): Promise<SubmitResult> {
    if (tx.Account !== this.wallet.classicAddress) {
      throw new ValidationError(`Transaction Account ${tx.Account} does not match signing wallet ${this.wallet.classicAddress}`)
    }
    const currentLedger = await this.client.getLedgerIndex()
    const prepared = await this.client.autofill({ ...tx, LastLedgerSequence: currentLedger + this.ledgerWindow })
    validate(prepared as unknown as Record<string, unknown>)
    const lastLedgerSequence = prepared.LastLedgerSequence ?? currentLedger + this.ledgerWindow
    const { tx_blob: blob, hash } = this.wallet.sign(prepared)

    // Log the hash before submitting so an interrupted process can always be reconciled.
    this.logger.info('tx.submit', { txType: tx.TransactionType, hash, account: tx.Account, sequence: prepared.Sequence, lastLedgerSequence })

    try {
      const response = await this.client.request({ command: 'submit', tx_blob: blob })
      const preliminary = response.result.engine_result
      // tem (malformed) and tef (failed, e.g. bad sequence) can never be included in a ledger.
      if (preliminary.startsWith('tem') || preliminary.startsWith('tef')) {
        this.logger.error('tx.rejected', { txType: tx.TransactionType, hash, resultCode: preliminary, message: response.result.engine_result_message })
        throw new TransactionFailedError(tx.TransactionType, hash, preliminary, false)
      }
    } catch (error) {
      if (error instanceof TransactionFailedError) throw error
      // The blob may still have reached the network, so the outcome is unknown
      // until LastLedgerSequence passes. Keep tracking it by hash.
      this.logger.warn('tx.submit_error', { txType: tx.TransactionType, hash, error: String(error) })
    }

    const result = await this.waitForValidation(tx.TransactionType, hash, currentLedger, lastLedgerSequence)
    const log = result.resultCode === 'tesSUCCESS' ? this.logger.info : this.logger.warn
    log('tx.validated', { txType: tx.TransactionType, hash, resultCode: result.resultCode, ledgerIndex: result.ledgerIndex })
    return result
  }

  private async waitForValidation(txType: string, hash: string, minLedger: number, lastLedgerSequence: number): Promise<SubmitResult> {
    for (;;) {
      await sleep(this.pollIntervalMs)
      try {
        const response = await this.client.request({ command: 'tx', transaction: hash, min_ledger: minLedger, max_ledger: lastLedgerSequence })
        const { meta, validated, ledger_index: ledgerIndex } = response.result
        if (validated === true && typeof meta === 'object' && ledgerIndex !== undefined) {
          return { hash, resultCode: meta.TransactionResult, ledgerIndex, meta }
        }
      } catch (error) {
        const data = error instanceof XrplError ? (error.data as { error?: string; searched_all?: boolean } | undefined) : undefined
        if (data?.error !== 'txnNotFound') throw error
        // searched_all means the node holds every ledger in [minLedger, lastLedgerSequence]
        // and the tx is in none of them; past LastLedgerSequence that is final.
        if (data.searched_all === true) {
          const validatedLedger = await this.client.getLedgerIndex()
          if (validatedLedger > lastLedgerSequence) {
            this.logger.error('tx.expired', { txType, hash, lastLedgerSequence })
            throw new TransactionExpiredError(txType, hash, lastLedgerSequence)
          }
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
