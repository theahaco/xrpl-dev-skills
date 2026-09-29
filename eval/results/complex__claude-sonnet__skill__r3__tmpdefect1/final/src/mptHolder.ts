import type { Client, Wallet, MPTokenAuthorize } from "xrpl";
import { submitAndRequireSuccess, type SubmitOutcome } from "./txSubmit";

/**
 * Holder-side helper: a holder must opt in before the issuer can approve
 * them (RequireAuth) or send them any MPT. This creates the holder's
 * MPToken ledger object with a zero balance.
 */
export async function optIn(client: Client, holderWallet: Wallet, issuanceId: string): Promise<SubmitOutcome> {
  const tx: MPTokenAuthorize = {
    TransactionType: "MPTokenAuthorize",
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
  };
  return submitAndRequireSuccess(client, holderWallet, tx);
}
