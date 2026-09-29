import type { Client, MPTokenAuthorize, Wallet } from "xrpl";

import { submitAndAssertSuccess } from "./txSubmit";

/**
 * Holder-side opt-in to an MPT issuance. This must be submitted by the
 * holder's own wallet (not the issuer) and creates the holder's MPToken
 * ledger object with a zero balance. It is a prerequisite for the issuer
 * being able to approve/allowlist the holder when RequireAuth is enabled.
 */
export async function optIntoIssuance(
  client: Client,
  holderWallet: Wallet,
  issuanceId: string,
): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: "MPTokenAuthorize",
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
  };

  await submitAndAssertSuccess(client, holderWallet, tx);
}
