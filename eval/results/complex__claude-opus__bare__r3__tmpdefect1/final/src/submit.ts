import {
  type Client,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
  RippledError,
} from 'xrpl'

import { SubmissionOutcomeUnknownError, TransactionFailedError } from './errors.js'

export interface SubmitOptions {
  /** How many ledgers the transaction stays valid for. Default 20 (~60-80s). */
  ledgerWindow?: number
  /** Poll interval while waiting for validation. Default 1000ms. */
  pollIntervalMs?: number
  /** Hard cap on how long to wait before reporting an unknown outcome. Default 180s. */
  timeoutMs?: number
}

export interface SubmitResult {
  hash: string
  ledgerIndex: number
  meta: TransactionMetadata
}

const DEFAULTS: Required<SubmitOptions> = {
  ledgerWindow: 20,
  pollIntervalMs: 1_000,
  timeoutMs: 180_000,
}

/**
 * Per-account serialization. Two concurrent submissions from the same account
 * would otherwise autofill the same Sequence and one would fail with
 * tefPAST_SEQ / terPRE_SEQ.
 */
const accountQueues = new Map<string, Promise<unknown>>()

function serialize<T>(account: string, task: () => Promise<T>): Promise<T> {
  const previous = accountQueues.get(account) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.catch(() => undefined)
  accountQueues.set(account, tail)
  void tail.then(() => {
    if (accountQueues.get(account) === tail) accountQueues.delete(account)
  })
  return run
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Sign and submit a transaction, then wait until its outcome is final.
 *
 * Resolves only on tesSUCCESS in a validated ledger. Throws
 * {@link TransactionFailedError} for any definitive failure and
 * {@link SubmissionOutcomeUnknownError} if the outcome can't be determined.
 * A resolved promise always means the change is in a validated ledger.
 */
export function submitAndConfirm(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  if (tx.Account !== wallet.classicAddress) {
    throw new Error(`Transaction Account ${tx.Account} does not match signer ${wallet.classicAddress}`)
  }
  return serialize(wallet.classicAddress, () => submitInner(client, wallet, tx, { ...DEFAULTS, ...options }))
}

async function submitInner(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  opts: Required<SubmitOptions>,
): Promise<SubmitResult> {
  await ensureConnected(client)
  const startLedger = await client.getLedgerIndex()
  const prepared = await client.autofill({ ...tx, LastLedgerSequence: startLedger + opts.ledgerWindow })
  const lastLedger = prepared.LastLedgerSequence
  if (lastLedger === undefined) throw new Error('autofill did not set LastLedgerSequence')

  const { tx_blob, hash } = wallet.sign(prepared)
  const type = tx.TransactionType

  try {
    const response = await client.request({ command: 'submit', tx_blob })
    const prelim = response.result.engine_result
    // tem = malformed, tef = failed before apply, tel = local error (not relayed).
    // None of these can end up in a ledger, so they are final.
    if (/^(tem|tef|tel)/.test(prelim)) {
      throw new TransactionFailedError(type, prelim, hash, false, `${type} rejected: ${prelim} (${response.result.engine_result_message})`)
    }
  } catch (err) {
    if (err instanceof TransactionFailedError) throw err
    // The submit may or may not have reached the network. Fall through and
    // look the hash up; it will either appear or definitively expire.
  }

  const deadline = Date.now() + opts.timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    await sleep(opts.pollIntervalMs)
    try {
      await ensureConnected(client)
      const outcome = await lookup(client, hash, startLedger, lastLedger)
      if (outcome === 'pending') continue
      if (outcome === 'expired') {
        throw new TransactionFailedError(type, 'expired', hash, false, `${type} ${hash} expired without being validated`)
      }
      const result = outcome.meta.TransactionResult
      if (result !== 'tesSUCCESS') {
        throw new TransactionFailedError(type, result, hash, true)
      }
      return { hash, ledgerIndex: outcome.ledgerIndex, meta: outcome.meta }
    } catch (err) {
      if (err instanceof TransactionFailedError) throw err
      lastError = err
    }
  }
  throw new SubmissionOutcomeUnknownError(type, hash, lastLedger, { cause: lastError })
}

type LookupOutcome = 'pending' | 'expired' | { meta: TransactionMetadata; ledgerIndex: number }

async function lookup(client: Client, hash: string, minLedger: number, lastLedger: number): Promise<LookupOutcome> {
  try {
    const res = await client.request({
      command: 'tx',
      transaction: hash,
      min_ledger: minLedger,
      max_ledger: lastLedger,
    })
    if (res.result.validated !== true) return 'pending'
    const meta = res.result.meta
    if (meta === undefined || typeof meta === 'string') throw new Error(`tx ${hash}: missing metadata`)
    return { meta, ledgerIndex: res.result.ledger_index ?? 0 }
  } catch (err) {
    if (err instanceof RippledError) {
      const data = err.data as { error?: string; searched_all?: boolean } | undefined
      if (data?.error === 'txnNotFound') {
        // Only safe to call it expired once the node has a complete history
        // for the whole validity window AND the window has closed.
        const validated = await client.getLedgerIndex()
        if (data.searched_all === true && validated > lastLedger) return 'expired'
        return 'pending'
      }
    }
    throw err
  }
}

async function ensureConnected(client: Client): Promise<void> {
  if (!client.isConnected()) await client.connect()
}
