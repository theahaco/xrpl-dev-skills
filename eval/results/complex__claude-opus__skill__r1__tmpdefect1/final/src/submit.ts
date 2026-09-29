import {
  Client,
  RippledError,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl'

/** Outcome of a transaction that reached a validated ledger. */
export interface TxOutcome {
  hash: string
  /** Engine result code, e.g. "tesSUCCESS" or "tecNO_AUTH". */
  result: string
  ledgerIndex: number
  meta: TransactionMetadata
}

/** The transaction was validated but did not succeed (a tec code). The fee was spent. */
export class TransactionFailedError extends Error {
  override readonly name = 'TransactionFailedError'
  constructor(
    readonly transactionType: string,
    readonly outcome: TxOutcome,
  ) {
    super(`${transactionType} failed with ${outcome.result} (tx ${outcome.hash})`)
  }

  get code(): string {
    return this.outcome.result
  }
}

/** The transaction was rejected before reaching a ledger and can never be included. */
export class TransactionRejectedError extends Error {
  override readonly name = 'TransactionRejectedError'
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly code: string,
    detail: string,
  ) {
    super(`${transactionType} rejected with ${code} (tx ${hash}): ${detail}`)
  }
}

export interface SubmitOptions {
  /** How long to keep polling for a final result before giving up (ms). */
  timeoutMs?: number
  pollIntervalMs?: number
}

const PERMANENT_REJECTION = /^(tem|tef)/

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Sign, submit and wait for a *final* outcome.
 *
 * Unlike a plain submit, this never leaves the caller guessing: it returns
 * only once the transaction is in a validated ledger, or once its
 * LastLedgerSequence has passed and the server has confirmed (searched_all)
 * that it was never included. Transient disconnects while waiting are retried,
 * so a dropped socket cannot cause a caller to resubmit (and e.g. double-pay).
 *
 * Throws TransactionFailedError for tec results so that compliance actions
 * can never be mistaken for having succeeded.
 */
export async function submitAndConfirm(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  options: SubmitOptions = {},
): Promise<TxOutcome> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000

  const prepared = await client.autofill({ ...tx, Account: wallet.classicAddress })
  const lastLedger = prepared.LastLedgerSequence
  if (lastLedger === undefined) {
    throw new Error('autofill did not set LastLedgerSequence; refusing to submit an unbounded transaction')
  }
  const minLedger = await client.getLedgerIndex()
  const { tx_blob: txBlob, hash } = wallet.sign(prepared)

  try {
    const response = await client.request({ command: 'submit', tx_blob: txBlob })
    const code = response.result.engine_result
    if (PERMANENT_REJECTION.test(code)) {
      throw new TransactionRejectedError(tx.TransactionType, hash, code, response.result.engine_result_message)
    }
    // tes/tec/ter/tel: the transaction may still be (or already be) included; wait for the final word.
  } catch (error) {
    if (error instanceof TransactionRejectedError) throw error
    // The submit may or may not have reached the network. Fall through and poll by hash.
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    try {
      if (!client.isConnected()) await client.connect()
      const response = await client.request({ command: 'tx', transaction: hash })
      const meta = response.result.meta
      if (response.result.validated === true && meta !== undefined && typeof meta === 'object') {
        const outcome: TxOutcome = {
          hash,
          result: meta.TransactionResult,
          ledgerIndex: response.result.ledger_index ?? 0,
          meta: meta as TransactionMetadata,
        }
        if (outcome.result !== 'tesSUCCESS') throw new TransactionFailedError(tx.TransactionType, outcome)
        return outcome
      }
    } catch (error) {
      if (error instanceof TransactionFailedError) throw error
      if (!(error instanceof RippledError) || !isTxnNotFound(error)) continue // transient; keep polling
      if ((await client.getLedgerIndex()) > lastLedger && (await searchedAll(client, hash, minLedger, lastLedger))) {
        throw new TransactionRejectedError(
          tx.TransactionType,
          hash,
          'EXPIRED',
          `not included by LastLedgerSequence ${lastLedger}`,
        )
      }
    }
  }
  throw new Error(
    `Timed out waiting for ${tx.TransactionType} ${hash}; its outcome is UNKNOWN. ` +
      'Look the hash up before retrying.',
  )
}

function isTxnNotFound(error: RippledError): boolean {
  const data = error.data as { error?: unknown } | undefined
  return data?.error === 'txnNotFound'
}

async function searchedAll(client: Client, hash: string, minLedger: number, maxLedger: number): Promise<boolean> {
  try {
    await client.request({ command: 'tx', transaction: hash, min_ledger: minLedger, max_ledger: maxLedger })
    return false // found after all; the next poll will report it
  } catch (error) {
    const data = (error as RippledError).data as { searched_all?: unknown } | undefined
    return data?.searched_all === true
  }
}
