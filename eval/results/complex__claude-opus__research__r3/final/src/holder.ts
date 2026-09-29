import { MPTokenAuthorizeFlags, type MPTokenAuthorize, type Payment, type Wallet } from 'xrpl'

import { toRawAmount } from './amount.js'
import { normalizeIssuanceId, readHolder } from './ledger.js'
import type { OpResult } from './issuer.js'
import type { TransactionSubmitter, TxReceipt } from './submit.js'

/**
 * Holder-side helpers. These are signed by the holder's own key, so they
 * belong in the holder's wallet/app, not the issuer backend; they are provided
 * for onboarding flows and testing.
 */

/** Opts the holder in to the token by creating its MPToken entry. The issuer must then approve it. */
export async function optIn(submitter: TransactionSubmitter, holder: Wallet, issuanceId: string): Promise<OpResult> {
  const id = normalizeIssuanceId(issuanceId)
  if ((await readHolder(submitter.client, id, holder.classicAddress)).exists) {
    return { changed: false, reason: 'already opted in' }
  }
  const tx = await submitter.submit(holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: id,
  } satisfies MPTokenAuthorize)
  return { changed: true, tx }
}

/** Removes the holder's (zero-balance) MPToken entry, releasing its owner reserve. */
export async function optOut(submitter: TransactionSubmitter, holder: Wallet, issuanceId: string): Promise<TxReceipt> {
  return submitter.submit(holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: normalizeIssuanceId(issuanceId),
    Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
  } satisfies MPTokenAuthorize)
}

/** Builds (but does not submit) a holder-to-holder MPT transfer. */
export function buildTransfer(
  from: string,
  to: string,
  issuanceId: string,
  amount: string,
  assetScale: number,
): Payment {
  return {
    TransactionType: 'Payment',
    Account: from,
    Destination: to,
    Amount: { mpt_issuance_id: normalizeIssuanceId(issuanceId), value: toRawAmount(amount, assetScale).toString() },
  }
}
