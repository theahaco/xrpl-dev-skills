import type { Client, MPTokenAuthorize, Payment, Wallet } from 'xrpl';

import { toBaseUnits } from './amounts.js';
import { type SubmittedTransaction, TransactionSubmitter } from './submit.js';

/**
 * Holder-side operations. These are signed by the holder's own keys, so a
 * production issuer backend never runs them; they exist for the demo and for
 * integration tests.
 */
export class MptHolder {
  private readonly submitter: TransactionSubmitter;

  constructor(
    client: Client,
    wallet: Wallet,
    readonly issuanceId: string,
    readonly assetScale: number,
  ) {
    this.submitter = new TransactionSubmitter(client, wallet);
  }

  get address(): string {
    return this.submitter.address;
  }

  /** Opts in to holding the token (creates the holder's MPToken entry). */
  optIn(): Promise<SubmittedTransaction> {
    return this.submitter.submit<MPTokenAuthorize>({
      TransactionType: 'MPTokenAuthorize',
      Account: this.address,
      MPTokenIssuanceID: this.issuanceId,
    });
  }

  /** Sends `amount` (token units) to `destination`. */
  send(destination: string, amount: string): Promise<SubmittedTransaction> {
    return this.submitter.submit(this.payment(destination, amount));
  }

  /** Sends a payment that the ledger is expected to reject; resolves with the `tec` result. */
  sendExpectingFailure(destination: string, amount: string): Promise<SubmittedTransaction> {
    return this.submitter.submitExpectingFailure(this.payment(destination, amount));
  }

  private payment(destination: string, amount: string): Payment {
    return {
      TransactionType: 'Payment',
      Account: this.address,
      Destination: destination,
      Amount: { mpt_issuance_id: this.issuanceId, value: toBaseUnits(amount, this.assetScale).toString() },
    };
  }
}
