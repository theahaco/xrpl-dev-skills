import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { type Payment } from 'xrpl';
import { TransactionRunner, type Signer } from './transactions.js';
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare const REQUIRED_FLAGS: number;
export declare function amount(value: string): string;
export declare function address(value: string): string;
export declare function issuanceId(value: string): string;
export declare function tokenPayment(id: string, from: string, to: string, value: string): Payment;
/** Amounts are integer ledger units; AssetScale is display metadata, never floating-point arithmetic. */
export declare class MptIssuer {
    readonly runner: TransactionRunner;
    private readonly signer;
    readonly id: string;
    private readonly queue;
    private constructor();
    get account(): string;
    static create(runner: TransactionRunner, signer: Signer, operation: string, options: {
        maximumAmount: string;
        assetScale?: number;
    }): Promise<MptIssuer>;
    static connect(runner: TransactionRunner, signer: Signer, id: string): Promise<MptIssuer>;
    issuance(ledgerHash?: string): Promise<MPTokenIssuance>;
    holder(holder: string, ledgerHash?: string): Promise<MPToken | undefined>;
    private checkHolder;
    private banKey;
    private allowed;
    approve(holder: string, operation: string): Promise<import("./state.js").Receipt>;
    mint(holder: string, value: string, operation: string): Promise<import("./state.js").Receipt>;
    clawback(holder: string, value: string, operation: string): Promise<import("./state.js").Receipt>;
    private clawbackInternal;
    freezeHolder(holder: string, operation: string): Promise<import("./state.js").Receipt>;
    unfreezeHolder(holder: string, operation: string): Promise<import("./state.js").Receipt>;
    freezeAll(operation: string): Promise<import("./state.js").Receipt>;
    unfreezeAll(operation: string): Promise<import("./state.js").Receipt>;
    private lock;
    /** Restartable, fail-closed workflow: persist intent -> revoke auth -> claw back -> verify.
     * Revocation fences incoming funds even if holder deletes/recreates its holding.
     * Redemption to issuer can race the clawback; it only reduces the balance further.
     */
    ban(holder: string, reason: string, operation: string): Promise<void>;
}
