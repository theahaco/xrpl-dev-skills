import type { Client, Wallet } from 'xrpl'
import { parsePositiveAmount, type MptAmountInput } from './amount.js'
import { submitAndConfirm, type SubmittedTransaction } from './submit.js'

/*
 * Holder-side actions. The issuer backend never holds holder keys; these exist for demos,
 * integration tests and holder-facing tooling.
 */

/** Opts a holder in to an issuance (creates their MPToken entry). The issuer must then approve them. */
export function optIn(client: Client, holder: Wallet, issuanceId: string): Promise<SubmittedTransaction> {
  return submitAndConfirm(client, holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  })
}

/** Sends the token from one holder to another address. */
export function transfer(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  amount: MptAmountInput,
): Promise<SubmittedTransaction> {
  return submitAndConfirm(client, from, {
    TransactionType: 'Payment',
    Account: from.classicAddress,
    Destination: to,
    Amount: { mpt_issuance_id: issuanceId, value: parsePositiveAmount(amount).toString() },
  })
}
