import {
  type Client,
  type SubmittableTransaction,
  type TransactionMetadata,
  type TxResponse,
  hashes,
} from 'xrpl'
import {
  TransactionFailedError,
  TransactionNotAppliedError,
  TransactionOutcomeUnknownError,
} from './errors.js'

/**
 * Anything that can sign transactions for one account. `xrpl.Wallet` meets
 * this interface. In production, a KMS- or HSM-backed signer can be dropped in.
 */
export interface Signer {
  readonly classicAddress: string
  sign(transaction: SubmittableTransaction): { tx_blob: string; hash: string }
}

export interface Receipt {
  hash: string
  ledgerIndex: number
  resultCode: 'tesSUCCESS'
  meta: TransactionMetadata
}

export interface SubmitterOptions {
  /** How many ledgers a transaction stays valid for before it expires. Default 20 (about 60-80s). */
  ledgerWindow?: number
  /** Polling interval while waiting for validation, in ms. Default 1000. */
  pollIntervalMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Signs and submits transactions for a single account, then waits for each
 * one's final validated outcome.
 *
 * Every call runs through one queue, so autofilled sequence numbers never
 * collide. Outcomes are reported with distinct errors:
 *  - success returns a {@link Receipt};
 *  - validated but unsuccessful (`tec*`) throws {@link TransactionFailedError};
 *  - definitely not applied throws {@link TransactionNotAppliedError};
 *  - cannot be determined (e.g. connection lost) throws {@link TransactionOutcomeUnknownError}.
 */
export class Submitter {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly ledgerWindow: number
  private readonly pollIntervalMs: number

  constructor(
    private readonly client: Client,
    private readonly signer: Signer,
    options: SubmitterOptions = {},
  ) {
    this.ledgerWindow = options.ledgerWindow ?? 20
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
  }

  get address(): string {
    return this.signer.classicAddress
  }

  /**
   * Runs `fn` exclusively: no other queued call starts until it settles. Use
   * this to keep a read-check-then-submit sequence atomic against concurrent
   * callers in the same process.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Submits a transaction and waits for its final outcome. Call only from inside {@link exclusive}. */
  async submitUnlocked(tx: SubmittableTransaction): Promise<Receipt> {
    if (tx.Account !== this.signer.classicAddress) {
      throw new Error(`Transaction Account ${tx.Account} does not match signer ${this.signer.classicAddress}`)
    }
    const prepared = await this.client.autofill(tx)
    const validated = await this.client.getLedgerIndex()
    prepared.LastLedgerSequence = validated + this.ledgerWindow
    const { tx_blob: blob, hash } = this.signer.sign(prepared)
    if (hash !== hashes.hashSignedTx(blob)) throw new Error('Signer returned a hash that does not match the blob')
    const lastLedger = prepared.LastLedgerSequence

    let preliminary: string
    try {
      const response = await this.client.request({ command: 'submit', tx_blob: blob })
      preliminary = response.result.engine_result
    } catch (error) {
      throw new TransactionOutcomeUnknownError(tx.TransactionType, hash, lastLedger, error)
    }
    // tem: malformed; tef: failed without claiming a fee (e.g. sequence already used).
    // Neither kind can ever be included in a ledger.
    if (preliminary.startsWith('tem') || preliminary.startsWith('tef')) {
      throw new TransactionNotAppliedError(tx.TransactionType, preliminary, hash, 'rejected on submission')
    }

    return this.awaitOutcome(tx.TransactionType, hash, lastLedger, preliminary)
  }

  private async awaitOutcome(
    type: string,
    hash: string,
    lastLedger: number,
    preliminary: string,
  ): Promise<Receipt> {
    for (;;) {
      await sleep(this.pollIntervalMs)
      let response: TxResponse | undefined
      let validatedSeq: number
      try {
        // Read the validated ledger index BEFORE looking up the transaction.
        // Otherwise it could be validated in ledger N == lastLedger while we
        // wrongly conclude it expired.
        validatedSeq = await this.validatedLedgerIndex()
        response = await this.lookup(hash)
      } catch (error) {
        throw new TransactionOutcomeUnknownError(type, hash, lastLedger, error)
      }
      if (response?.result.validated) {
        const meta = response.result.meta
        if (meta == null || typeof meta === 'string') {
          throw new TransactionOutcomeUnknownError(type, hash, lastLedger, 'validated without metadata')
        }
        const code = meta.TransactionResult
        if (code !== 'tesSUCCESS') throw new TransactionFailedError(type, code, hash)
        return { hash, ledgerIndex: response.result.ledger_index ?? validatedSeq, resultCode: code, meta }
      }
      if (validatedSeq > lastLedger) {
        throw new TransactionNotAppliedError(
          type,
          preliminary,
          hash,
          `expired: not in any validated ledger up to LastLedgerSequence ${lastLedger}`,
        )
      }
    }
  }

  private async validatedLedgerIndex(): Promise<number> {
    const response = await this.client.request({ command: 'ledger', ledger_index: 'validated' })
    return response.result.ledger_index
  }

  private async lookup(hash: string): Promise<TxResponse | undefined> {
    try {
      return (await this.client.request({ command: 'tx', transaction: hash })) as TxResponse
    } catch (error) {
      if ((error as { data?: { error?: string } }).data?.error === 'txnNotFound') return undefined
      throw error
    }
  }
}
