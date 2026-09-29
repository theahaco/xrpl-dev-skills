import type { Client, Wallet } from "xrpl";
import type { SubmittedTx } from "./types";
/**
 * Holder-side opt-in: a prospective holder authorizes themselves to hold an
 * MPT issuance by creating their own MPToken object. This must be signed by
 * the holder's own key, so it does not belong on the issuer module (which
 * only ever holds the issuer's key) — it's exposed here as a convenience for
 * callers that control holder keys directly, such as this repo's demo script
 * or a wallet-side integration.
 *
 * If the issuance has RequireAuth set, the holder still cannot receive
 * tokens until the issuer separately approves them (see `MptIssuer.approveHolder`).
 */
export declare function optInHolder(client: Client, holderWallet: Wallet, issuanceId: string): Promise<SubmittedTx>;
