import { MPTokenAuthorizeFlags, type Client, type Wallet } from 'xrpl'

import { parsePositiveAmount, type MptAmount } from './amounts.js'
import { Submitter, type SubmitterOptions, type ValidatedTransaction } from './submitter.js'

/**
 * Holder-side actions. Not part of the issuer's controls. Holders sign these
 * themselves; this exists for wallets, integration tests and the demo.
 */
export class MptHolder {
  readonly address: string
  private readonly submitter: Submitter

  constructor(client: Client, wallet: Wallet, options?: SubmitterOptions) {
    this.submitter = new Submitter(client, wallet, options)
    this.address = wallet.classicAddress
  }

  /** Opts in to holding the token (creates the holder's MPToken entry). */
  async optIn(issuanceId: string): Promise<ValidatedTransaction> {
    return this.submitter.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.address,
      MPTokenIssuanceID: issuanceId,
    })
  }

  /** Deletes the holder's MPToken entry (balance must be zero). */
  async optOut(issuanceId: string): Promise<ValidatedTransaction> {
    return this.submitter.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.address,
      MPTokenIssuanceID: issuanceId,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
  }

  /** Sends tokens to another holder, or to the issuer (redemption). */
  async send(issuanceId: string, destination: string, amount: MptAmount): Promise<ValidatedTransaction> {
    return this.submitter.submit({
      TransactionType: 'Payment',
      Account: this.address,
      Destination: destination,
      Amount: { mpt_issuance_id: issuanceId, value: parsePositiveAmount(amount).toString() },
    })
  }
}
