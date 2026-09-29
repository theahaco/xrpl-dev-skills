import type { MPToken, MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/index.js';
import { type MPTokenAuthorize } from 'xrpl';
import { Submitter, type Signer } from './ledger.js';
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export declare function issuanceId(value: string): string;
export declare function holderOptIn(account: string, id: string): MPTokenAuthorize;
/** Amounts are integer base units. AssetScale is deliberately zero for this issuance. */
export declare class MptIssuer {
    readonly submitter: Submitter;
    private readonly signer;
    private readonly serial;
    readonly id: string;
    constructor(submitter: Submitter, signer: Signer, id: string);
    static create(submitter: Submitter, signer: Signer, operationId: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    assertConfiguration(): Promise<void>;
    private banKey;
    isBanned(holder: string): boolean;
    private allowed;
    approve(holder: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    issue(holder: string, value: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    clawback(holder: string, value: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    private claw;
    private lock;
    setHolderFreeze(holder: string, frozen: boolean, operationId: string): Promise<import("./ledger.js").Receipt>;
    setGlobalFreeze(frozen: boolean, operationId: string): Promise<import("./ledger.js").Receipt>;
    /** Resumable multi-transaction workflow. Persist intent, revoke receipt rights, then drain.
     * Redemption remains possible under MPT locks; revocation prevents incoming balance races.
     * A holder deleting/recreating their MPToken cannot restore issuer authorization.
     */
    ban(holder: string, operationId: string): Promise<void>;
}
