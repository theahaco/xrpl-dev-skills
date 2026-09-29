"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertTesSuccess = assertTesSuccess;
const errors_1 = require("./errors");
/**
 * Validates a submitAndWait response: throws unless the transaction is both
 * validated in a ledger AND resulted in tesSUCCESS. A `tec*` result means
 * the transaction made it into a validated ledger but failed — fees were
 * still spent and the intended state change did NOT happen, so this must
 * never be treated as a soft success.
 */
function assertTesSuccess(response, ErrorClass = errors_1.IssuerTransactionError) {
    const txType = response.result.tx_json.TransactionType;
    const hash = response.result.hash;
    if (!response.result.validated) {
        throw new ErrorClass(`${txType} was not validated (hash ${hash})`, txType, undefined, hash);
    }
    const meta = response.result.meta;
    if (meta === undefined || typeof meta === "string") {
        throw new ErrorClass(`${txType} returned no parsed metadata (hash ${hash})`, txType, undefined, hash);
    }
    if (meta.TransactionResult !== "tesSUCCESS") {
        throw new ErrorClass(`${txType} failed with ${meta.TransactionResult} (hash ${hash})`, txType, meta.TransactionResult, hash);
    }
}
//# sourceMappingURL=submit.js.map