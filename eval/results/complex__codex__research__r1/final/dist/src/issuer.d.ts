import { Client, type MPTokenMetadata, type MPTokenAuthorize } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { Transactions, type Signer } from './transactions.js';
import { type Receipt } from './store.js';
export declare const MAX_AMOUNT = "9223372036854775807";
export declare const CAPABILITIES: number;
export declare const LOCKED = 1;
export declare const AUTHORIZED = 2;
/** Amounts are integer base units, never floating point. This issuance uses AssetScale=0. */
export declare function amount(value: string): string;
export declare function holderAddress(value: string, issuer: string): string;
export declare function issuanceId(value: string): string;
export declare function preflight(client: Client): Promise<unknown>;
/** Account-wide restriction: block direct redemption, including the native MPT lock exception.
 * No account or credential DepositPreauth entries are permitted for this dedicated issuer.
 */
export declare function requireRedemptionGuard(client: Client, issuer: string, ledger?: number | 'validated'): Promise<import("xrpl/dist/npm/models/ledger/AccountRoot.js").default>;
export declare function readHolding(client: Client, id: string, holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
export declare function readIssuance(client: Client, id: string, ledger?: number | 'validated'): Promise<MPTokenIssuance>;
/** Backend issuer API. The caller is responsible for KYC decisions and access control.
 * DepositAuth closes the holder redemption exception; issue() closes issuer mint exceptions.
 * Unrestricted issuer signing can always bypass policy. Use a dedicated issuer exclusively via this API.
 * Each mutating call needs a unique, durable business operation ID.
 */
export declare class MptIssuer {
    readonly id: string;
    private readonly tx;
    private readonly signer;
    private constructor();
    static configureIssuer(tx: Transactions, signer: Signer, operationId: string): Promise<void>;
    static create(tx: Transactions, signer: Signer, operationId: string, metadata?: MPTokenMetadata): Promise<MptIssuer>;
    static attach(tx: Transactions, signer: Signer, id: string): Promise<MptIssuer>;
    private serial;
    private holder;
    private banKey;
    private ensureNotBanned;
    /** Holder signs this separately; issuer approval alone does not create the holder entry. */
    optInTransaction(holder: string): MPTokenAuthorize;
    approve(holder: string, operationId: string): Promise<Receipt>;
    issue(holder: string, value: string, operationId: string): Promise<Receipt>;
    clawback(holder: string, value: string, operationId: string): Promise<Receipt>;
    private clawbackInternal;
    /** Lock plus issuer DepositAuth blocks holder-initiated movements. */
    freezeHolder(holder: string, frozen: boolean, operationId: string): Promise<Receipt>;
    freezeGlobal(frozen: boolean, operationId: string): Promise<Receipt>;
    /** Resumable saga: persist ban -> revoke authorization -> drain -> verify.
     * No unban API. A holder can delete/recreate an empty entry, but cannot restore issuer authorization.
     * Only reports success after validated zero balance and revoked authorization.
     */
    ban(holder: string, reason: string, operationId: string): Promise<void>;
}
