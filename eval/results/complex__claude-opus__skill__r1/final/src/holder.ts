import { Client, MPTokenAuthorizeFlags, type Wallet } from 'xrpl'

import { toBaseUnits } from './amount.js'
import { submitAndConfirm, type SubmitOptions, type TxOutcome } from './submit.js'

/**
 * Holder-side actions. These are signed by the holder, not the issuer, so they
 * are not part of the issuer module; they exist for onboarding flows, tests
 * and the demo.
 */

/** Opt in to an issuance (creates the holder's MPToken entry). Required before the issuer can approve them. */
export async function optIn(client: Client, holder: Wallet, issuanceId: string, options?: SubmitOptions): Promise<TxOutcome> {
  return submitAndConfirm(
    client,
    holder,
    { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: issuanceId },
    options,
  )
}

/** Delete the holder's (zero-balance) MPToken entry. */
export async function optOut(client: Client, holder: Wallet, issuanceId: string, options?: SubmitOptions): Promise<TxOutcome> {
  return submitAndConfirm(
    client,
    holder,
    {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    },
    options,
  )
}

/** Send tokens from a holder to another holder (or back to the issuer). */
export async function transfer(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  amount: string,
  assetScale: number,
  options?: SubmitOptions,
): Promise<TxOutcome> {
  return submitAndConfirm(
    client,
    from,
    {
      TransactionType: 'Payment',
      Account: from.classicAddress,
      Destination: to,
      Amount: { mpt_issuance_id: issuanceId, value: toBaseUnits(amount, assetScale).toString() },
    },
    options,
  )
}
