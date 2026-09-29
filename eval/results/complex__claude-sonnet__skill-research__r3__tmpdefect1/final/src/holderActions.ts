import type { Client, MPTokenAuthorize, Wallet } from 'xrpl'

import { submitAndVerify } from './txHelpers.js'

/**
 * Holder-side action: opts a holder in to an MPT issuance by creating their
 * (initially unauthorized, zero-balance) MPToken object. Must be signed by
 * the holder itself -- in production this runs in the holder's own wallet or
 * client, never in the issuer's backend.
 */
export async function optIntoIssuance(
  client: Client,
  holderWallet: Wallet,
  issuanceId: string,
): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
  }
  await submitAndVerify(client, holderWallet, tx)
}
