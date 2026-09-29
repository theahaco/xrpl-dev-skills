import type { Client, Wallet } from 'xrpl'

import { type SubmittedTransaction, submitTransaction } from './ledger.js'

/**
 * Holder-side operations. In production holders sign these in their own
 * wallets; these helpers exist for tooling, tests and the demo.
 */

/** Opts in to holding the token by creating the holder's `MPToken` entry. */
export function optIn(client: Client, holder: Wallet, issuanceId: string): Promise<SubmittedTransaction> {
  return submitTransaction(client, holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.address,
    MPTokenIssuanceID: issuanceId,
  })
}

/** Sends `baseUnits` of the token from one holder to another account. */
export function transfer(
  client: Client,
  from: Wallet,
  destination: string,
  issuanceId: string,
  baseUnits: bigint,
): Promise<SubmittedTransaction> {
  return submitTransaction(client, from, {
    TransactionType: 'Payment',
    Account: from.address,
    Destination: destination,
    Amount: { mpt_issuance_id: issuanceId, value: baseUnits.toString() },
  })
}
