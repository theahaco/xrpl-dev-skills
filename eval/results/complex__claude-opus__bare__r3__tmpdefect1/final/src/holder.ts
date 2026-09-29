import { type Client, type Wallet, MPTokenAuthorizeFlags } from 'xrpl'

import { parseAmount, type Amount } from './issuer.js'
import { type SubmitOptions, type SubmitResult, submitAndConfirm } from './submit.js'

/**
 * Holder-side transactions. The issuer never holds these keys in production;
 * these helpers exist for wallets, tests and the demo.
 */

/** Opt in to an issuance by creating an MPToken entry. The issuer must still approve it. */
export function optIn(client: Client, holder: Wallet, issuanceId: string, opts?: SubmitOptions): Promise<SubmitResult> {
  return submitAndConfirm(
    client,
    holder,
    { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: issuanceId },
    opts,
  )
}

/** Opt out by deleting the MPToken entry. Only possible with a zero balance. */
export function optOut(client: Client, holder: Wallet, issuanceId: string, opts?: SubmitOptions): Promise<SubmitResult> {
  return submitAndConfirm(
    client,
    holder,
    {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    },
    opts,
  )
}

/** Send tokens from a wallet (holder or issuer) to another account. */
export function transfer(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  amount: Amount,
  opts?: SubmitOptions,
): Promise<SubmitResult> {
  return submitAndConfirm(
    client,
    from,
    {
      TransactionType: 'Payment',
      Account: from.classicAddress,
      Destination: to,
      Amount: { mpt_issuance_id: issuanceId, value: parseAmount(amount).toString() },
    },
    opts,
  )
}
