import type { Client, Wallet } from 'xrpl'
import { toMptValue } from './amount.js'
import { type ValidatedTx, submitAndValidate } from './submit.js'

/*
 * Holder-side transactions. The issuer backend never holds customer keys; these
 * exist for tests, demos and custodial tooling.
 */

/** Holder opts in to the token (creates their MPToken entry). Approval by the issuer is still required. */
export function optIn(client: Client, holder: Wallet, issuanceId: string): Promise<ValidatedTx> {
  return submitAndValidate(client, holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  })
}

/** Holder sends tokens to another address. */
export function transfer(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  amount: bigint | string,
): Promise<ValidatedTx> {
  return submitAndValidate(client, from, {
    TransactionType: 'Payment',
    Account: from.classicAddress,
    Destination: to,
    Amount: { mpt_issuance_id: issuanceId, value: toMptValue(amount) },
  })
}
