import type { Client, Wallet } from 'xrpl';
import { toRawAmount } from './amount.js';
import type { AuditLogger } from './logger.js';
import { submitAndConfirm, type SubmitOptions, type SubmittedTransaction } from './submit.js';

/**
 * Holder-side operations. These are signed by the holder's own key, so in
 * production they run in the holder's wallet, not in the issuer backend.
 * They're provided for onboarding tooling, tests and the demo.
 */

/** Opts the holder in to the token (creates their MPToken entry, costing one owner reserve). */
export function optIn(
  client: Client,
  holder: Wallet,
  issuanceId: string,
  logger: AuditLogger,
  submit?: SubmitOptions,
): Promise<SubmittedTransaction> {
  return submitAndConfirm(
    client,
    holder,
    { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: issuanceId },
    logger,
    submit,
  );
}

/** Sends tokens from one holder to another address. */
export function transfer(
  client: Client,
  from: Wallet,
  destination: string,
  issuanceId: string,
  amount: string,
  assetScale: number,
  logger: AuditLogger,
  submit?: SubmitOptions,
): Promise<SubmittedTransaction> {
  return submitAndConfirm(
    client,
    from,
    {
      TransactionType: 'Payment',
      Account: from.classicAddress,
      Destination: destination,
      Amount: { mpt_issuance_id: issuanceId, value: toRawAmount(amount, assetScale).toString() },
    },
    logger,
    submit,
  );
}
