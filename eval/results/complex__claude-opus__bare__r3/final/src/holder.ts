import { type Client, type Wallet } from 'xrpl'

import { submitAsIssuer } from './MptIssuer.js'

/**
 * Holder-side opt-in: creates the holder's MPToken for an issuance. With
 * RequireAuth the holder still cannot receive the token until the issuer
 * approves them. Runs with the holder's own keys, so in production this is
 * submitted by the holder's wallet, not the issuer backend.
 */
export async function optIn(client: Client, holder: Wallet, issuanceId: string): Promise<string> {
  const res = await submitAsIssuer(client, holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  })
  return res.result.hash
}

/** Holder-to-holder transfer of `rawAmount` ledger units. */
export async function transfer(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  rawAmount: bigint,
): Promise<string> {
  const res = await submitAsIssuer(client, from, {
    TransactionType: 'Payment',
    Account: from.classicAddress,
    Destination: to,
    Amount: { mpt_issuance_id: issuanceId, value: rawAmount.toString() },
  })
  return res.result.hash
}
