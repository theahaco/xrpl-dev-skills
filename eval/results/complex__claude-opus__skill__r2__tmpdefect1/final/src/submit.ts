import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'
import { TransactionExpiredError, TransactionFailedError } from './errors.js'

export interface ValidatedTx {
  hash: string
  ledgerIndex: number
  meta: TransactionMetadata
}

const POLL_INTERVAL_MS = 1_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Autofill, sign and submit `tx` from `wallet`, then wait until it is in a
 * validated ledger.
 *
 * Resolves only on `tesSUCCESS`. Any other outcome throws:
 * - `TransactionFailedError` (applied = false) for `tem`/`tef`/`tel` preliminary results,
 *   which cannot be included in a ledger in their current form.
 * - `TransactionFailedError` (applied = true) for a validated non-success (`tec`) result.
 * - `TransactionExpiredError` if LastLedgerSequence passes without validation.
 *
 * Unlike `Client.submitAndWait`, this fails immediately on `tef`/`tel` instead of
 * waiting for LastLedgerSequence to pass.
 */
export async function submitAndValidate(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<ValidatedTx> {
  const prepared = await client.autofill({ ...tx, Account: wallet.classicAddress })
  const lastLedger = prepared.LastLedgerSequence
  if (lastLedger === undefined) {
    throw new Error('autofill did not set LastLedgerSequence')
  }
  const { tx_blob, hash } = wallet.sign(prepared)

  const submitted = await client.request({ command: 'submit', tx_blob })
  const prelim = submitted.result.engine_result
  if (/^(tem|tef|tel)/.test(prelim)) {
    throw new TransactionFailedError(tx.TransactionType, prelim, hash, false, submitted.result.engine_result_message)
  }

  // `tes`, `tec` and `ter` preliminary results can all still end up in a validated
  // ledger, so the only reliable answer is the validated one.
  for (;;) {
    await sleep(POLL_INTERVAL_MS)
    const found = await lookupValidated(client, hash)
    if (found) {
      const code = found.meta.TransactionResult
      if (code !== 'tesSUCCESS') {
        throw new TransactionFailedError(tx.TransactionType, code, hash, true)
      }
      return found
    }
    // Only give up once a validated ledger beyond LastLedgerSequence exists, and
    // re-check after that point to avoid racing the final ledger.
    const validatedIndex = await client.getLedgerIndex()
    if (validatedIndex > lastLedger) {
      if (await lookupValidated(client, hash)) continue
      throw new TransactionExpiredError(tx.TransactionType, hash, lastLedger)
    }
  }
}

async function lookupValidated(client: Client, hash: string): Promise<ValidatedTx | undefined> {
  try {
    const res = await client.request({ command: 'tx', transaction: hash })
    if (!res.result.validated) return undefined
    const meta = res.result.meta
    if (meta === undefined || typeof meta === 'string' || res.result.ledger_index === undefined) {
      throw new Error(`Unexpected tx response shape for ${hash}`)
    }
    return { hash, ledgerIndex: res.result.ledger_index, meta }
  } catch (err) {
    if ((err as { data?: { error?: string } }).data?.error === 'txnNotFound') return undefined
    throw err
  }
}
