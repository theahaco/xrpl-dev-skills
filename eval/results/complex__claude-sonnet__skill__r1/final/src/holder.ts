import type { Client, MPTokenAuthorize, TxResponse, Wallet } from 'xrpl'

import { submitAndVerify } from './txSubmit.js'

/**
 * Holder-side helper: a holder opts in to an MPT issuance by submitting
 * their own `MPTokenAuthorize`, creating their (initially unauthorized)
 * MPToken object. This is not part of the issuer's compliance surface —
 * it requires the holder's own signature — but the demo needs it to bring
 * a holder to a state the issuer can then allowlist.
 */
export async function optInToIssuance(
  client: Client,
  holder: Wallet,
  issuanceId: string,
): Promise<TxResponse> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  }
  return submitAndVerify(client, holder, tx)
}
