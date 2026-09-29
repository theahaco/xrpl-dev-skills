import { type Client, type LedgerEntry, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';
import { IssuerError } from './errors.js';
/** An MPToken ledger entry. xrpl.js's MPToken type omits the `Account` field. */
export interface MPTokenEntry {
    Account: string;
    MPTokenIssuanceID: string;
    /** Omitted by the ledger when the balance is zero. */
    MPTAmount?: string;
    LockedAmount?: string;
    Flags: number;
}
/** MPToken ledger-entry flags (xrpl.js does not export an enum for these). */
export declare const MPTokenFlags: {
    readonly lsfMPTLocked: 1;
    readonly lsfMPTAuthorized: 2;
};
export interface ValidatedTx {
    hash: string;
    transactionType: string;
    resultCode: string;
    ledgerIndex: number;
    meta: TransactionMetadata;
}
/**
 * The transaction was signed and may have been broadcast, but its final outcome
 * isn't known (for example, the connection dropped). Use `hash` to look it up
 * before retrying. The transaction can't be validated after `lastLedgerSequence`.
 */
export declare class SubmissionOutcomeUnknownError extends IssuerError {
    readonly hash: string;
    readonly lastLedgerSequence: number | undefined;
    constructor(hash: string, lastLedgerSequence: number | undefined, cause: unknown);
}
/**
 * Autofills, signs, submits and waits for validation. Resolves with the validated
 * result, including tec failures. Throws TransactionFailedError for malformed (tem)
 * transactions. Throws SubmissionOutcomeUnknownError when the final outcome can't be
 * established (for example a disconnect, or tef/ter results that never validated).
 */
export declare function submitAndValidate(client: Client, wallet: Wallet, tx: SubmittableTransaction, expectedNetworkId: number | undefined): Promise<ValidatedTx>;
/** Like {@link submitAndValidate}, but throws unless the result is tesSUCCESS. */
export declare function submitOrThrow(client: Client, wallet: Wallet, tx: SubmittableTransaction, expectedNetworkId: number | undefined): Promise<ValidatedTx>;
export declare function assertNetwork(client: Client, expectedNetworkId: number | undefined): void;
export declare function getIssuanceEntry(client: Client, issuanceId: string): Promise<LedgerEntry.MPTokenIssuance | null>;
export declare function getMPTokenEntry(client: Client, issuanceId: string, account: string): Promise<MPTokenEntry | null>;
