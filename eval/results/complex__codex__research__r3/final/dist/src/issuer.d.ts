import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { type Payment, type MPTokenAuthorize } from 'xrpl';
import { Ledger, type Signer } from './ledger.js';
export { Ledger, TESTNET, checkTestnet, TransactionFailure, UncertainTransaction } from './ledger.js';
export { Store } from './store.js';
export type { Signer } from './ledger.js';
export declare const MAX_AMOUNT = "9223372036854775807";
export declare const ISSUANCE_FLAGS: number;
export declare function amount(value: string): string;
export declare function address(value: string): string;
export declare function issuanceId(value: string): string;
export declare function optIn(holder: string, id: string): MPTokenAuthorize;
export declare function payment(sender: string, destination: string, id: string, value: string): Payment;
/** Native XRPL MPT controls. Locks permit redemption to issuer; see README. */
export declare class MptIssuer {
    readonly ledger: Ledger;
    private readonly signer;
    readonly id: string;
    private constructor();
    static create(ledger: Ledger, signer: Signer, operationKey: string): Promise<MptIssuer>;
    static attach(ledger: Ledger, signer: Signer, id: string): Promise<MptIssuer>;
    issuance(ledgerIndex?: number | 'validated'): Promise<MPTokenIssuance>;
    holding(holder: string, ledgerIndex?: number | 'validated'): Promise<MPToken | undefined>;
    private holder;
    private assertNotBanned;
    /** Holder must first submit optIn(). kycReference is an opaque internal reference, never PII. */
    approve(holder: string, kycReference: string, key: string): Promise<import("./store.js").Receipt>;
    issue(holder: string, value: string, key: string): Promise<import("./store.js").Receipt>;
    clawback(holder: string, value: string, key: string): Promise<import("./store.js").Receipt>;
    private clawbackInternal;
    setHolderFreeze(holder: string, frozen: boolean, key: string): Promise<import("./store.js").Receipt>;
    setGlobalFreeze(frozen: boolean, key: string): Promise<import("./store.js").Receipt>;
    private lock;
    /** Resumable, not atomic: return only after validated zero balance and authorization removal.
     * The persistent tombstone is written first. Re-run ban() after any interruption.
     * Lock stops peer movement; revocation survives holder deletion/recreation of its MPToken.
     */
    ban(holder: string, reason: string): Promise<void>;
}
