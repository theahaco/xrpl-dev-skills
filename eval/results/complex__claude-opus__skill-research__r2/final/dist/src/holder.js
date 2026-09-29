"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MptHolder = void 0;
const xrpl_1 = require("xrpl");
const amount_js_1 = require("./amount.js");
const submitter_js_1 = require("./submitter.js");
/**
 * Actions a token holder takes on their own account. This is not part of the
 * issuer backend: the demo and tests use it to act as the holders.
 */
class MptHolder {
    wallet;
    issuanceId;
    assetScale;
    #submitter;
    constructor(client, wallet, issuanceId, assetScale, logger) {
        this.wallet = wallet;
        this.issuanceId = issuanceId;
        this.assetScale = assetScale;
        this.#submitter = new submitter_js_1.TransactionSubmitter(client, wallet, logger === undefined ? {} : { logger });
    }
    get address() {
        return this.wallet.classicAddress;
    }
    /** Creates the holder's MPToken entry (costs one owner reserve). The issuer must still approve it. */
    optIn() {
        return this.#submitter.submit({
            TransactionType: 'MPTokenAuthorize',
            Account: this.address,
            MPTokenIssuanceID: this.issuanceId,
        });
    }
    /** Deletes the holder's MPToken entry. Only possible with a zero balance. */
    optOut() {
        return this.#submitter.submit({
            TransactionType: 'MPTokenAuthorize',
            Account: this.address,
            MPTokenIssuanceID: this.issuanceId,
            Flags: xrpl_1.MPTokenAuthorizeFlags.tfMPTUnauthorize,
        });
    }
    send(destination, amount) {
        return this.#submitter.submit({
            TransactionType: 'Payment',
            Account: this.address,
            Destination: destination,
            Amount: {
                mpt_issuance_id: this.issuanceId,
                value: (0, amount_js_1.toPositiveBaseUnits)(amount, this.assetScale).toString(),
            },
        });
    }
}
exports.MptHolder = MptHolder;
//# sourceMappingURL=holder.js.map