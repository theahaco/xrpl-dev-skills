import type { Client, MPTAmount, Wallet } from 'xrpl';
import { type AmountInput, parsePositiveAmount } from './amounts.js';
import { assertClassicAddress, assertIssuanceId, readHolder, type HolderLedgerState } from './ledger.js';
import { type SubmittedTransaction, TransactionSubmitter, type SubmitterOptions } from './submitter.js';

/**
 * Holder-side operations: what a holder's own wallet does. The issuer backend
 * never holds these keys in production. This exists for integration testing
 * and the demo.
 */
export class MptHolder {
  private readonly submitter: TransactionSubmitter;

  constructor(
    private readonly client: Client,
    wallet: Wallet,
    readonly issuanceId: string,
    options?: SubmitterOptions,
  ) {
    assertIssuanceId(issuanceId);
    this.submitter = new TransactionSubmitter(client, wallet, options);
  }

  get address(): string {
    return this.submitter.address;
  }

  /** Create this account's MPToken entry (a prerequisite for issuer approval). */
  optIn(): Promise<SubmittedTransaction> {
    return this.submitter.submit({ TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: this.issuanceId });
  }

  /** Delete this account's MPToken entry (requires a zero balance). */
  optOut(): Promise<SubmittedTransaction> {
    return this.submitter.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: 0x01, // tfMPTUnauthorize
    });
  }

  send(destination: string, amount: AmountInput): Promise<SubmittedTransaction> {
    assertClassicAddress(destination, 'destination');
    const Amount: MPTAmount = { mpt_issuance_id: this.issuanceId, value: parsePositiveAmount(amount).toString() };
    return this.submitter.submit({ TransactionType: 'Payment', Account: this.address, Destination: destination, Amount });
  }

  state(): Promise<HolderLedgerState> {
    return readHolder(this.client, this.issuanceId, this.address);
  }
}
