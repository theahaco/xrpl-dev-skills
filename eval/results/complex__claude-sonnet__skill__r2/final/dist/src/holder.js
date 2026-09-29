"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optInHolder = optInHolder;
const errors_1 = require("./errors");
const submit_1 = require("./submit");
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
async function optInHolder(client, holderWallet, issuanceId) {
    const tx = {
        TransactionType: "MPTokenAuthorize",
        Account: holderWallet.address,
        MPTokenIssuanceID: issuanceId,
    };
    const response = await client.submitAndWait(tx, { wallet: holderWallet });
    (0, submit_1.assertTesSuccess)(response, errors_1.IssuerTransactionError);
    return { hash: response.result.hash, ledgerIndex: response.result.ledger_index };
}
//# sourceMappingURL=holder.js.map