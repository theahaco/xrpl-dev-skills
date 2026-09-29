import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'
import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors'

export interface SubmitOptions {
  /** How often to poll for the validated outcome. Default 1000 ms. */
  pollIntervalMs?: number
  /**
   * How many ledgers the transaction stays valid for. Default 20 (roughly a
   * minute). After this, an unconfirmed transaction can never be applied.
   */
  ledgerWindow?: number
}

export interface SubmitResult {
  hash: string
  ledgerIndex: number
  meta: TransactionMetadata
}

/**
 * Engine results that mean the signed blob was not (and will never be) applied.
 * `tefPAST_SEQ` / `tefALREADY` are deliberately absent: after a reconnect they
 * can mean "this exact blob was already applied", so we poll for it instead.
 */
function isDefinitiveRejection(code: string): boolean {
  if (code.startsWith('tem') || code.startsWith('tel')) return true
  return code.startsWith('tef') && code !== 'tefPAST_SEQ' && code !== 'tefALREADY'
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Autofills, signs and submits a transaction, then waits for a *validated*
 * outcome. Resolves only on `tesSUCCESS`; throws {@link TransactionFailedError}
 * for any other final result and {@link TransactionOutcomeUnknownError} when the
 * outcome cannot be proven either way.
 *
 * Unlike `client.submitAndWait`, expiry is only reported once a validated
 * ledger past `LastLedgerSequence` is known NOT to contain the transaction, so
 * a transaction included in its last valid ledger is never misreported as failed.
 */
export async function submitAndConfirm(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const ledgerWindow = options.ledgerWindow ?? 20

  const prepared = await client.autofill(tx)
  const startLedger = await client.getLedgerIndex()
  const lastLedger = startLedger + ledgerWindow
  prepared.LastLedgerSequence = lastLedger
  const { tx_blob: blob, hash } = wallet.sign(prepared)
  const type = tx.TransactionType

  try {
    const response = await client.request({ command: 'submit', tx_blob: blob })
    const code = response.result.engine_result
    if (isDefinitiveRejection(code)) {
      throw new TransactionFailedError(type, code, hash, `${type} rejected with ${code}: ${response.result.engine_result_message}`)
    }
  } catch (error) {
    if (error instanceof TransactionFailedError) throw error
    // The request may or may not have reached the network; fall through and
    // find out by polling for the hash.
  }

  for (;;) {
    await sleep(pollIntervalMs)
    try {
      const response = await client.request({ command: 'tx', transaction: hash })
      const { meta, validated, ledger_index: ledgerIndex } = response.result
      if (validated && meta && typeof meta === 'object' && ledgerIndex !== undefined) {
        if (meta.TransactionResult !== 'tesSUCCESS') {
          throw new TransactionFailedError(type, meta.TransactionResult, hash)
        }
        return { hash, ledgerIndex, meta }
      }
    } catch (error) {
      if (error instanceof TransactionFailedError) throw error
      if (!isTxNotFound(error)) {
        // Transient connection problem: keep polling until we can decide.
        if (!client.isConnected()) await client.connect().catch(() => undefined)
        continue
      }
    }

    // Not (yet) in a validated ledger. Only give up once the network has
    // validated a ledger past LastLedgerSequence and the server holds the full
    // range of history in which the transaction could have appeared.
    const validatedLedger = await client.getLedgerIndex().catch(() => undefined)
    if (validatedLedger === undefined || validatedLedger <= lastLedger) continue
    const notFound = await provenNotIncluded(client, hash, startLedger, lastLedger)
    if (notFound === true) {
      throw new TransactionFailedError(type, 'expired', hash, `${type} ${hash} expired without being included in a validated ledger`)
    }
    if (notFound === 'unknown') {
      throw new TransactionOutcomeUnknownError(type, hash, lastLedger)
    }
  }
}

async function provenNotIncluded(
  client: Client,
  hash: string,
  minLedger: number,
  maxLedger: number,
): Promise<boolean | 'found' | 'unknown'> {
  try {
    await client.request({ command: 'tx', transaction: hash, min_ledger: minLedger, max_ledger: maxLedger })
    return 'found' // appeared in the meantime; the caller's loop picks it up
  } catch (error) {
    if (isTxNotFound(error)) {
      const searchedAll = (error as { data?: { searched_all?: boolean } }).data?.searched_all
      return searchedAll === true ? true : 'unknown'
    }
    return 'unknown'
  }
}

function isTxNotFound(error: unknown): boolean {
  return (error as { data?: { error?: string } } | undefined)?.data?.error === 'txnNotFound'
}
