import type { Client, Wallet } from 'xrpl'
import { parseAmount, type MptAmountInput } from './amount'
import { submitAndConfirm, type SubmitOptions, type SubmitResult } from './submit'

/**
 * Holder-side actions. These are signed by the holder's own key, so in
 * production they run in the holder's wallet, not in the issuer backend. They
 * are provided for onboarding flows, tests and the demo.
 */

/** Opts in to holding the token (creates the holder's MPToken entry). */
export function optIn(client: Client, holder: Wallet, issuanceId: string, options?: SubmitOptions): Promise<SubmitResult> {
  return submitAndConfirm(
    client,
    holder,
    { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: issuanceId },
    options,
  )
}

/** Sends tokens from a holder to another account (holder or issuer). */
export function transfer(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  amount: MptAmountInput,
  options?: SubmitOptions,
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
    options,
  )
}
