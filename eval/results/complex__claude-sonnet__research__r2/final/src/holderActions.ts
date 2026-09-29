import type { Client, MPTokenAuthorize, Wallet } from 'xrpl'
import { submitAndCheck } from './submit'

/**
 * Holder-side action, not something the issuer backend can do on a holder's
 * behalf: a holder must submit their own MPTokenAuthorize (no Holder field)
 * to create their MPToken object before the issuer can approve them. This
 * lives outside MptIssuer because it is signed by the holder's own key; it
 * is exported for demos/tests that control holder wallets end-to-end.
 */
export async function optIntoMpt(client: Client, holderWallet: Wallet, issuanceId: string): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
  }
  await submitAndCheck(client, tx, holderWallet)
}
