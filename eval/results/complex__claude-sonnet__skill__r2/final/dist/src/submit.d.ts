import type { BaseTransaction, TxResponse } from "xrpl";
import { IssuerTransactionError } from "./errors";
/**
 * Validates a submitAndWait response: throws unless the transaction is both
 * validated in a ledger AND resulted in tesSUCCESS. A `tec*` result means
 * the transaction made it into a validated ledger but failed — fees were
 * still spent and the intended state change did NOT happen, so this must
 * never be treated as a soft success.
 */
export declare function assertTesSuccess<T extends BaseTransaction>(response: TxResponse<T>, ErrorClass?: typeof IssuerTransactionError): void;
