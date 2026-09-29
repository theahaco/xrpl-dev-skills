import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl'

import { parseLedgerAmount } from './amounts.js'
import { XrplTransactionError } from './errors.js'

/** `MPToken` ledger-entry flags. */
export const lsfMPTLocked = 0x00000001
export const lsfMPTAuthorized = 0x00000002

/** The `MPToken` fields this module reads. xrpl.js's `MPToken` type omits `Account`. */
export interface MPTokenEntry {
  Account: string
  MPTokenIssuanceID: string
  MPTAmount?: string
  Flags: number
}

export interface MPTokenIssuanceEntry {
  Issuer: string
  Flags: number
  AssetScale?: number
  MaximumAmount?: string
  OutstandingAmount: string
  TransferFee?: number
  MPTokenMetadata?: string
  Sequence: number
}

export interface SubmittedTransaction {
  hash: string
  ledgerIndex: number
  meta: TransactionMetadata
}

/**
 * Autofills, signs and submits a transaction, then waits for it to appear in a
 * validated ledger. Resolves only on `tesSUCCESS`; any other outcome throws an
 * `XrplTransactionError` carrying the result code and transaction hash.
 */
export async function submitTransaction(
  client: Client,
  wallet: Wallet,
  transaction: SubmittableTransaction,
): Promise<SubmittedTransaction> {
  const prepared = await client.autofill(transaction)
  const signed = wallet.sign(prepared)
  let response
  try {
    response = await client.submitAndWait(signed.tx_blob)
  } catch (error) {
    // submitAndWait throws on tem* results and when LastLedgerSequence passes.
    const message = error instanceof Error ? error.message : String(error)
    const code = /\b(te[cfmlr][A-Z_]+)\b/u.exec(message)?.[1] ?? 'SUBMISSION_FAILED'
    throw new XrplTransactionError(transaction.TransactionType, code, signed.hash, { cause: error })
  }
  const { meta, hash, ledger_index: ledgerIndex } = response.result
  if (typeof meta !== 'object' || meta === null || ledgerIndex === undefined) {
    throw new XrplTransactionError(transaction.TransactionType, 'MISSING_METADATA', hash)
  }
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new XrplTransactionError(transaction.TransactionType, meta.TransactionResult, hash)
  }
  return { hash, ledgerIndex, meta }
}

/** Reads an account's `MPToken` entry from the latest validated ledger, if it has one. */
export async function getMPToken(
  client: Client,
  issuanceId: string,
  account: string,
): Promise<MPTokenEntry | undefined> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account },
      ledger_index: 'validated',
    })
    return response.result.node as unknown as MPTokenEntry
  } catch (error) {
    if (isEntryNotFound(error)) return undefined
    throw error
  }
}

export async function getMPTokenIssuance(
  client: Client,
  issuanceId: string,
): Promise<MPTokenIssuanceEntry | undefined> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    return response.result.node as unknown as MPTokenIssuanceEntry
  } catch (error) {
    if (isEntryNotFound(error)) return undefined
    throw error
  }
}

/**
 * How much a holder's MPT balance fell in a transaction, read from its
 * metadata, e.g. 300n for a 300-unit clawback. Returns 0n if it didn't change.
 *
 * Only decreases can be read reliably: the ledger omits `MPTAmount` when it's
 * zero, so a rise from zero looks the same as an unchanged balance.
 */
export function mptBalanceDecrease(meta: TransactionMetadata, issuanceId: string, holder: string): bigint {
  for (const node of meta.AffectedNodes) {
    if (!('ModifiedNode' in node)) continue
    const modified = node.ModifiedNode
    if (modified.LedgerEntryType !== 'MPToken') continue
    const final = modified.FinalFields as Partial<MPTokenEntry> | undefined
    if (final?.Account !== holder || final.MPTokenIssuanceID !== issuanceId) continue
    const previous = modified.PreviousFields as Partial<MPTokenEntry> | undefined
    if (!previous || !('MPTAmount' in previous)) return 0n
    return parseLedgerAmount(previous.MPTAmount) - parseLedgerAmount(final.MPTAmount)
  }
  return 0n
}

function isEntryNotFound(error: unknown): boolean {
  const data = (error as { data?: { error?: string } } | null)?.data
  return data?.error === 'entryNotFound' || data?.error === 'objectNotFound'
}
