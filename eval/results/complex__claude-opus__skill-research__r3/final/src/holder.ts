import type { Wallet } from 'xrpl'
import type { TransactionSubmitter, ValidatedTransaction } from './submit.js'

/**
 * Holder-side actions. In production these are signed by the holder's own
 * wallet or custodian, not by the issuer backend. They're included here for
 * onboarding tooling and the demo.
 */

/** Opts the holder in to the token by creating their MPToken entry (costs one owner reserve). */
export async function optIn(submitter: TransactionSubmitter, holder: Wallet, issuanceId: string): Promise<ValidatedTransaction> {
  return submitter.submit(holder, {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  })
}

/** Builds a holder-to-holder payment of `baseUnits` (integer string) of the token. */
export function transferTx(from: Wallet, destination: string, issuanceId: string, baseUnits: string) {
  return {
    TransactionType: 'Payment' as const,
    Account: from.classicAddress,
    Destination: destination,
    Amount: { mpt_issuance_id: issuanceId, value: baseUnits },
  }
}
