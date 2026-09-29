import type { MPToken, MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/index.js';
import { type MPTokenAuthorize } from 'xrpl';
import { Runtime, type Signer } from './runtime.js';
export declare const CAPABILITIES: number;
export declare const LOCKED = 1;
export declare const AUTHORIZED = 2;
export declare const MAX_AMOUNT: string;
export declare function amount(value: string): string;
export declare function holderAddress(holder: string, issuer: string): string;
/** AssetScale=0: all amount strings are whole token units. KYC decisions belong to the caller. */
export declare class MptIssuer {
    readonly runtime: Runtime;
    private readonly signer;
    readonly issuanceId: string;
    private constructor();
    static create(runtime: Runtime, signer: Signer, operationId: string): Promise<MptIssuer>;
    static attach(runtime: Runtime, signer: Signer, id: string): Promise<MptIssuer>;
    get address(): string;
    private get policyPath();
    private policy;
    isBanned(holder: string): Promise<boolean>;
    private allowed;
    issuance(ledgerHash?: string): Promise<MPTokenIssuance>;
    holder(holder: string, ledgerHash?: string): Promise<MPToken | undefined>;
    assertConfiguration(): Promise<void>;
    /** Holder signs this independently. This opts in; it does not grant issuer approval. */
    optInTransaction(holder: string): MPTokenAuthorize;
    approve(holder: string, id: string): Promise<void>;
    issue(holder: string, value: string, id: string): Promise<void>;
    clawback(holder: string, value: string, id: string): Promise<void>;
    private clawbackInternal;
    private lockInternal;
    setHolderFreeze(holder: string, freeze: boolean, id: string): Promise<void>;
    setGlobalFreeze(freeze: boolean, id: string): Promise<void>;
    /** Durable deny policy first, then lock, revoke, drain. Retry with the SAME id after interruption. */
    ban(holder: string, reason: string, id: string): Promise<void>;
}
