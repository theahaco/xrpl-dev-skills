import { type Client, type LedgerEntry, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';
/** MPToken ledger-entry flags (not exported as an enum by xrpl.js). */
export declare const MPTokenFlags: {
    readonly lsfMPTLocked: 1;
    readonly lsfMPTAuthorized: 2;
};
export interface ValidatedTransaction {
    hash: string;
    ledgerIndex: number;
    resultCode: 'tesSUCCESS';
    meta: TransactionMetadata;
}
/**
 * Autofill, sign, submit and wait for a transaction to reach a final outcome
 * in a validated ledger.
 *
 * - Resolves only when the transaction is validated with tesSUCCESS.
 * - Throws `TransactionFailedError` when the outcome is final and not tesSUCCESS
 *   (validated with a tec code, rejected with tem/tef, or expired past its
 *   LastLedgerSequence without being included).
 * - Throws `TransactionOutcomeUnknownError` when the outcome can't be established
 *   (e.g. connection loss). The error carries the hash so callers can reconcile.
 */
export declare function submitTransaction(client: Client, wallet: Wallet, transaction: SubmittableTransaction): Promise<ValidatedTransaction>;
export declare function getValidatedLedgerIndex(client: Client): Promise<number>;
export declare function rippledErrorCode(error: unknown): string | undefined;
export declare function fetchIssuance(client: Client, issuanceId: string): Promise<LedgerEntry.MPTokenIssuance | undefined>;
export declare function fetchMPToken(client: Client, issuanceId: string, account: string): Promise<LedgerEntry.MPToken | undefined>;
export declare function accountExists(client: Client, address: string): Promise<boolean>;
