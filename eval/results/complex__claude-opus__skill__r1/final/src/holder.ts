import { type Client, type MPTAmount, type Wallet } from 'xrpl';

import { assertClassicAddress, normalizeIssuanceId, parseAmount, type MptAmount } from './amounts.js';
import { submitAndConfirm, submitOrThrow, type SubmitOptions, type ValidatedTransaction } from './submit.js';

/**
 * Holder-side operations. The issuer backend never holds holder keys in production;
 * these exist for the demo, integration tests and wallet tooling.
 */

/** Holder opts in to the token by creating their MPToken entry (reserve: one owner reserve). */
export function optIn(client: Client, holder: Wallet, issuanceId: string, options?: SubmitOptions): Promise<ValidatedTransaction> {
  return submitOrThrow(
    client,
    holder,
    { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: normalizeIssuanceId(issuanceId) },
    options,
  );
}

/**
 * Sends the token. Returns the validated result without throwing on `tec` codes,
 * so callers can assert that compliance controls rejected a transfer.
 */
export function transfer(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  amount: MptAmount,
  options?: SubmitOptions,
): Promise<ValidatedTransaction> {
  assertClassicAddress(to, 'destination');
  const mpt: MPTAmount = { mpt_issuance_id: normalizeIssuanceId(issuanceId), value: parseAmount(amount).toString() };
  return submitAndConfirm(client, from, { TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: mpt }, options);
}
