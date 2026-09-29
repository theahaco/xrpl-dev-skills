import {
  type Client,
  type LedgerEntry,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
  RippledError,
  XrplError,
} from 'xrpl'

import { IssuerError, TransactionFailedError } from './errors.js'

/** An MPToken ledger entry. xrpl.js's MPToken type omits the `Account` field. */
export interface MPTokenEntry {
  Account: string
  MPTokenIssuanceID: string
  /** Omitted by the ledger when the balance is zero. */
  MPTAmount?: string
  LockedAmount?: string
  Flags: number
}

/** MPToken ledger-entry flags (xrpl.js does not export an enum for these). */
export const MPTokenFlags = {
  lsfMPTLocked: 0x0000_0001,
  lsfMPTAuthorized: 0x0000_0002,
} as const

export interface ValidatedTx {
  hash: string
  transactionType: string
  resultCode: string
  ledgerIndex: number
  meta: TransactionMetadata
}

/**
 * The transaction was signed and may have been broadcast, but its final outcome
 * isn't known (for example, the connection dropped). Use `hash` to look it up
 * before retrying. The transaction can't be validated after `lastLedgerSequence`.
 */
export class SubmissionOutcomeUnknownError extends IssuerError {
  constructor(
    readonly hash: string,
    readonly lastLedgerSequence: number | undefined,
    cause: unknown,
  ) {
    super(`Outcome of transaction ${hash} is unknown (LastLedgerSequence ${lastLedgerSequence ?? 'unset'})`, {
      cause,
    })
  }
}

/**
 * Autofills, signs, submits and waits for validation. Resolves with the validated
 * result, including tec failures. Throws TransactionFailedError for malformed (tem)
 * transactions. Throws SubmissionOutcomeUnknownError when the final outcome can't be
 * established (for example a disconnect, or tef/ter results that never validated).
 */
export async function submitAndValidate(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  expectedNetworkId: number | undefined,
): Promise<ValidatedTx> {
  assertNetwork(client, expectedNetworkId)
  const prepared = await client.autofill(tx)
  const signed = wallet.sign(prepared)
  let response
  try {
    response = await client.submitAndWait(signed.tx_blob)
  } catch (err) {
    // xrpl.js reports tem (malformed) results right away, and those are final.
    // Any other failure means the transaction could still be validated.
    const temCode = err instanceof XrplError ? /^Transaction failed, (tem[A-Z_]+)/.exec(err.message)?.[1] : undefined
    if (temCode) throw new TransactionFailedError(tx.TransactionType, temCode, signed.hash)
    throw new SubmissionOutcomeUnknownError(signed.hash, prepared.LastLedgerSequence, err)
  }
  const { meta, validated, ledger_index: ledgerIndex } = response.result
  if (!validated || typeof meta !== 'object' || meta === null || ledgerIndex === undefined) {
    throw new SubmissionOutcomeUnknownError(signed.hash, prepared.LastLedgerSequence, 'response not validated')
  }
  return {
    hash: signed.hash,
    transactionType: tx.TransactionType,
    resultCode: meta.TransactionResult,
    ledgerIndex,
    meta,
  }
}

/** Like {@link submitAndValidate}, but throws unless the result is tesSUCCESS. */
export async function submitOrThrow(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  expectedNetworkId: number | undefined,
): Promise<ValidatedTx> {
  const result = await submitAndValidate(client, wallet, tx, expectedNetworkId)
  if (result.resultCode !== 'tesSUCCESS') {
    throw new TransactionFailedError(result.transactionType, result.resultCode, result.hash)
  }
  return result
}

export function assertNetwork(client: Client, expectedNetworkId: number | undefined): void {
  if (expectedNetworkId === undefined) return
  if (client.networkID !== expectedNetworkId) {
    throw new IssuerError(
      `Connected to network ${client.networkID ?? 'unknown'} but expected ${expectedNetworkId}; refusing to sign`,
    )
  }
}

export async function getIssuanceEntry(
  client: Client,
  issuanceId: string,
): Promise<LedgerEntry.MPTokenIssuance | null> {
  return ledgerEntryOrNull<LedgerEntry.MPTokenIssuance>(client, { mpt_issuance: issuanceId })
}

export async function getMPTokenEntry(
  client: Client,
  issuanceId: string,
  account: string,
): Promise<MPTokenEntry | null> {
  return ledgerEntryOrNull<MPTokenEntry>(client, { mptoken: { mpt_issuance_id: issuanceId, account } })
}

async function ledgerEntryOrNull<T>(
  client: Client,
  selector: { mpt_issuance: string } | { mptoken: { mpt_issuance_id: string; account: string } },
): Promise<T | null> {
  try {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector })
    return response.result.node as T
  } catch (err) {
    if (err instanceof RippledError && (err.data as { error?: string } | undefined)?.error === 'entryNotFound') {
      return null
    }
    throw err
  }
}
