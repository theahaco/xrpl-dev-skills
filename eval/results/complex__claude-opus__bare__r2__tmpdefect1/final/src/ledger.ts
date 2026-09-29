import type { Client, TransactionMetadata } from 'xrpl'

import { ledgerAmount } from './amount.js'
import { isRippledError } from './submitter.js'

/** The MPTokenIssuance fields this module reads. */
export interface IssuanceEntry {
  Issuer: string
  Flags: number
  OutstandingAmount: string
  MaximumAmount?: string
  AssetScale?: number
  LockedAmount?: string
  DomainID?: string
}

/** The MPToken (holder) fields this module reads. */
export interface HolderEntry {
  Account: string
  MPTokenIssuanceID: string
  Flags: number
  MPTAmount?: string
  LockedAmount?: string
}

export async function readIssuance(client: Client, issuanceId: string): Promise<IssuanceEntry | undefined> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    return response.result.node as unknown as IssuanceEntry
  } catch (error) {
    if (isRippledError(error, 'entryNotFound')) return undefined
    throw error
  }
}

export async function readHolder(
  client: Client,
  issuanceId: string,
  account: string,
): Promise<HolderEntry | undefined> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account },
      ledger_index: 'validated',
    })
    return response.result.node as unknown as HolderEntry
  } catch (error) {
    if (isRippledError(error, 'entryNotFound')) return undefined
    throw error
  }
}

/**
 * How much a transaction debited from the holder, taken from its metadata.
 * This is the authoritative figure, e.g. when the ledger caps a clawback at
 * the available balance.
 *
 * Only valid for debits: a zero balance is stored as an absent field, so a
 * credit from zero leaves no 'previous' amount to compare against.
 */
export function holderDebit(meta: TransactionMetadata, issuanceId: string, account: string): bigint {
  for (const affected of meta.AffectedNodes) {
    const node = 'ModifiedNode' in affected ? affected.ModifiedNode : undefined
    if (node?.LedgerEntryType !== 'MPToken') continue
    const final = node.FinalFields as Partial<HolderEntry> | undefined
    if (final?.Account !== account || final.MPTokenIssuanceID !== issuanceId) continue
    const previous = node.PreviousFields as Partial<HolderEntry> | undefined
    if (previous?.MPTAmount === undefined) return 0n
    return ledgerAmount(previous.MPTAmount) - ledgerAmount(final.MPTAmount)
  }
  return 0n
}

export async function isAmendmentEnabled(client: Client, name: string): Promise<boolean | undefined> {
  try {
    const response = await client.request({ command: 'feature' })
    const features = (response.result as { features?: Record<string, { name: string; enabled: boolean }> }).features
    if (features === undefined) return undefined
    return Object.values(features).some((f) => f.name === name && f.enabled)
  } catch {
    return undefined
  }
}
