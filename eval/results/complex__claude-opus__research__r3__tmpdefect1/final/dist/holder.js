/**
 * Holder-side actions. These are signed by the holder, not the issuer; the
 * backend doesn't need them in production, but the demo and integration tests
 * use them to act as holders.
 */
import { MPTokenAuthorizeFlags } from 'xrpl';
import { submitTransaction } from './ledger.js';
/** Opt in to holding an MPT (creates the holder's MPToken entry). Required before the issuer can authorize them. */
export function optIn(client, holder, issuanceId) {
    return submitTransaction(client, holder, {
        TransactionType: 'MPTokenAuthorize',
        Account: holder.classicAddress,
        MPTokenIssuanceID: issuanceId,
    });
}
/** Opt out (delete the holder's MPToken entry). Only possible with a zero balance. */
export function optOut(client, holder, issuanceId) {
    return submitTransaction(client, holder, {
        TransactionType: 'MPTokenAuthorize',
        Account: holder.classicAddress,
        MPTokenIssuanceID: issuanceId,
        Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    });
}
/** Send `rawAmount` (on-ledger integer units) of the MPT to another account. */
export function transfer(client, holder, destination, issuanceId, rawAmount) {
    return submitTransaction(client, holder, {
        TransactionType: 'Payment',
        Account: holder.classicAddress,
        Destination: destination,
        Amount: { mpt_issuance_id: issuanceId, value: rawAmount.toString() },
    });
}
//# sourceMappingURL=holder.js.map