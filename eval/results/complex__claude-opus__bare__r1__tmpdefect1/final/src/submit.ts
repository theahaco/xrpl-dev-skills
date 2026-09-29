import { setTimeout as sleep } from 'node:timers/promises'
import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'
import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors.js'

export interface SubmittedTransaction {
  hash: string
  ledgerIndex: number
  meta: TransactionMetadata
}

const POLL_INTERVAL_MS = 1_000
const MAX_CONSECUTIVE_LOOKUP_ERRORS = 30

/**
 * Signs and submits a transaction, then waits until its outcome is final:
 * either validated in a ledger, or provably never applied (its LastLedgerSequence has passed
 * and the server has complete history over the window in which it could have been included).
 *
 * Resolves only on `tesSUCCESS`; every other outcome throws {@link TransactionFailedError}.
 */
export async function submitAndConfirm(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<SubmittedTransaction> {
  const prepared = await client.autofill(tx)
  const lastLedger = prepared.LastLedgerSequence
  if (lastLedger === undefined) {
    throw new Error('autofill did not set LastLedgerSequence')
  }
  const { tx_blob: txBlob, hash } = wallet.sign(prepared)
  const firstLedger = await client.getLedgerIndex()

  const submitted = await client.request({ command: 'submit', tx_blob: txBlob })
  const preliminary = submitted.result.engine_result
  // tem (malformed) and tef (failed, e.g. past sequence) can never be applied later.
  if (preliminary.startsWith('tem') || preliminary.startsWith('tef')) {
    throw new TransactionFailedError('rejected', tx.TransactionType, preliminary, hash)
  }

  let consecutiveErrors = 0
  for (;;) {
    await sleep(POLL_INTERVAL_MS)
    let found: Lookup
    try {
      found = await lookupTransaction(client, hash, firstLedger, lastLedger)
      consecutiveErrors = 0
    } catch (error) {
      // The transaction may still be applied, so a lookup failure must not be reported as a failure.
      if (++consecutiveErrors >= MAX_CONSECUTIVE_LOOKUP_ERRORS) {
        throw new TransactionOutcomeUnknownError(tx.TransactionType, hash, { cause: error })
      }
      continue
    }
    if (found.status === 'validated') {
      const result = found.meta.TransactionResult
      if (result !== 'tesSUCCESS') {
        throw new TransactionFailedError('failed', tx.TransactionType, result, hash, found.ledgerIndex)
      }
      return { hash, ledgerIndex: found.ledgerIndex, meta: found.meta }
    }
    if (found.status === 'expired') {
      throw new TransactionFailedError('expired', tx.TransactionType, preliminary, hash)
    }
  }
}

type Lookup =
  | { status: 'validated'; ledgerIndex: number; meta: TransactionMetadata }
  | { status: 'pending' }
  | { status: 'expired' }

async function lookupTransaction(
  client: Client,
  hash: string,
  minLedger: number,
  maxLedger: number,
): Promise<Lookup> {
  try {
    const response = await client.request({
      command: 'tx',
      transaction: hash,
      min_ledger: minLedger,
      max_ledger: maxLedger,
    })
    const { validated, meta, ledger_index: ledgerIndex } = response.result
    if (validated === true && typeof meta === 'object' && ledgerIndex !== undefined) {
      return { status: 'validated', ledgerIndex, meta }
    }
    return { status: 'pending' }
  } catch (error) {
    const data = (error as { data?: { error?: string; searched_all?: boolean } }).data
    if (data?.error !== 'txnNotFound') throw error
    // Only conclude "never applied" once every ledger up to LastLedgerSequence is validated
    // and the server confirms it searched all of them.
    if (data.searched_all === true && (await client.getLedgerIndex()) > maxLedger) {
      return { status: 'expired' }
    }
    return { status: 'pending' }
  }
}

/**
 * Runs async tasks one at a time, in call order. Used so that concurrent callers sharing one
 * signing account never race on its Sequence number, and so multi-step operations
 * (such as a ban) are not interleaved with other operations.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }
}
