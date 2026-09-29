/**
 * Low-level ledger access shared by the issuer and holder helpers:
 * reliable transaction submission and validated-ledger lookups.
 */
import { setTimeout as sleep } from 'node:timers/promises'

import {
  type Client,
  type LedgerEntry,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
  RippledError,
} from 'xrpl'

import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors.js'

/** MPToken ledger-entry flags (not exported as an enum by xrpl.js). */
export const MPTokenFlags = {
  lsfMPTLocked: 0x00000001,
  lsfMPTAuthorized: 0x00000002,
} as const

export interface ValidatedTransaction {
  hash: string
  ledgerIndex: number
  resultCode: 'tesSUCCESS'
  meta: TransactionMetadata
}

const POLL_INTERVAL_MS = 1_000

/**
 * Autofill, sign, submit and wait for a transaction to reach a final outcome
 * in a validated ledger.
 *
 * - Resolves only when the transaction is validated with tesSUCCESS.
 * - Throws `TransactionFailedError` when the outcome is final and not tesSUCCESS
 *   (validated with a tec code, rejected with tem/tef, or expired past its
 *   LastLedgerSequence without being included).
 * - Throws `TransactionOutcomeUnknownError` when the outcome can't be established
 *   (e.g. connection loss). The error carries the hash so callers can reconcile.
 */
export async function submitTransaction(
  client: Client,
  wallet: Wallet,
  transaction: SubmittableTransaction,
): Promise<ValidatedTransaction> {
  const type = transaction.TransactionType
  // autofill sets Fee, Sequence, NetworkID and LastLedgerSequence (current + 20).
  const prepared = await client.autofill(transaction)
  const lastLedgerSequence = prepared.LastLedgerSequence
  if (lastLedgerSequence === undefined) {
    throw new Error(`${type}: autofill did not set LastLedgerSequence`)
  }
  const signed = wallet.sign(prepared)

  let engineResult: string
  try {
    const response = await client.request({ command: 'submit', tx_blob: signed.tx_blob })
    engineResult = response.result.engine_result
  } catch (error) {
    // The transaction may or may not have reached the network.
    return await waitForOutcome(client, type, signed.hash, lastLedgerSequence).catch((waitError: unknown) => {
      throw waitError instanceof TransactionFailedError
        ? waitError
        : new TransactionOutcomeUnknownError(type, signed.hash, error)
    })
  }

  // tem (malformed) and tef (can't ever apply, e.g. past sequence) are final.
  // Every other preliminary result (including tec/ter/tel) is provisional.
  if (engineResult.startsWith('tem') || engineResult.startsWith('tef')) {
    throw new TransactionFailedError(type, engineResult, signed.hash)
  }

  try {
    return await waitForOutcome(client, type, signed.hash, lastLedgerSequence)
  } catch (error) {
    if (error instanceof TransactionFailedError) {
      throw error
    }
    throw new TransactionOutcomeUnknownError(type, signed.hash, error)
  }
}

async function waitForOutcome(
  client: Client,
  type: string,
  hash: string,
  lastLedgerSequence: number,
): Promise<ValidatedTransaction> {
  for (;;) {
    await sleep(POLL_INTERVAL_MS)
    const found = await lookupTransaction(client, hash)
    if (found !== undefined) {
      if (found.resultCode !== 'tesSUCCESS') {
        throw new TransactionFailedError(type, found.resultCode, hash)
      }
      return { hash, ledgerIndex: found.ledgerIndex, resultCode: 'tesSUCCESS', meta: found.meta }
    }
    const validatedIndex = await getValidatedLedgerIndex(client)
    if (validatedIndex > lastLedgerSequence) {
      // Re-check once: the transaction could have been validated in the
      // ledger that just pushed us past LastLedgerSequence.
      const lastChance = await lookupTransaction(client, hash)
      if (lastChance === undefined) {
        throw new TransactionFailedError(type, 'expired (LastLedgerSequence passed)', hash)
      }
      if (lastChance.resultCode !== 'tesSUCCESS') {
        throw new TransactionFailedError(type, lastChance.resultCode, hash)
      }
      return { hash, ledgerIndex: lastChance.ledgerIndex, resultCode: 'tesSUCCESS', meta: lastChance.meta }
    }
  }
}

async function lookupTransaction(
  client: Client,
  hash: string,
): Promise<{ resultCode: string; ledgerIndex: number; meta: TransactionMetadata } | undefined> {
  try {
    const response = await client.request({ command: 'tx', transaction: hash })
    const { validated, meta, ledger_index: ledgerIndex } = response.result
    if (validated !== true || meta === undefined || typeof meta === 'string' || ledgerIndex === undefined) {
      return undefined
    }
    return { resultCode: meta.TransactionResult, ledgerIndex, meta }
  } catch (error) {
    if (rippledErrorCode(error) === 'txnNotFound') {
      return undefined
    }
    throw error
  }
}

export async function getValidatedLedgerIndex(client: Client): Promise<number> {
  const response = await client.request({ command: 'ledger', ledger_index: 'validated' })
  return response.result.ledger_index
}

export function rippledErrorCode(error: unknown): string | undefined {
  if (error instanceof RippledError && typeof error.data === 'object' && error.data !== null) {
    const code = (error.data as { error?: unknown }).error
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export async function fetchIssuance(
  client: Client,
  issuanceId: string,
): Promise<LedgerEntry.MPTokenIssuance | undefined> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    const node = response.result.node
    return node?.LedgerEntryType === 'MPTokenIssuance' ? node : undefined
  } catch (error) {
    if (rippledErrorCode(error) === 'entryNotFound') {
      return undefined
    }
    throw error
  }
}

export async function fetchMPToken(
  client: Client,
  issuanceId: string,
  account: string,
): Promise<LedgerEntry.MPToken | undefined> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account },
      ledger_index: 'validated',
    })
    // xrpl.js 5.3.0's LedgerEntry union omits MPToken, so narrow at runtime.
    const node = response.result.node as { LedgerEntryType?: string } | undefined
    return node?.LedgerEntryType === 'MPToken' ? (node as LedgerEntry.MPToken) : undefined
  } catch (error) {
    if (rippledErrorCode(error) === 'entryNotFound') {
      return undefined
    }
    throw error
  }
}

export async function accountExists(client: Client, address: string): Promise<boolean> {
  try {
    await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
    return true
  } catch (error) {
    if (rippledErrorCode(error) === 'actNotFound') {
      return false
    }
    throw error
  }
}
