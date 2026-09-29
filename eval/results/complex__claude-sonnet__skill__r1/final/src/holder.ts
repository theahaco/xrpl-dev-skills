import { Client, Wallet } from 'xrpl';
import type { MPTokenAuthorize } from 'xrpl';
import { submitAndCheck } from './mptIssuer';

/**
 * Holder-side opt-in: creates the holder's MPToken ledger object for this issuance.
 * Must be signed by the holder's own key, so this is not a method on {@link MptIssuer}
 * (an issuer backend should never hold a customer's private key). In production this
 * transaction is submitted by the holder's own wallet/app, not the issuer's backend.
 */
export async function holderOptIn(client: Client, holderWallet: Wallet, issuanceId: string): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
  };
  await submitAndCheck(client, holderWallet, tx);
}
