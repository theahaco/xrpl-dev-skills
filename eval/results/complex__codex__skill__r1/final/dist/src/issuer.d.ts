import { Wallet, type Payment } from 'xrpl';
import { Transactions } from './transactions.js';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const MAX_AMOUNT = "9223372036854775807";
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export declare function address(value: string): string;
export declare function issuanceID(value: string): string;
export declare function payment(account: string, destination: string, id: string, value: string): Payment;
/** Native MPT locks permit redemption to the issuer, even while frozen. */
export declare class MptIssuer {
    readonly transactions: Transactions;
    private readonly wallet;
    readonly issuanceId: string;
    private readonly store;
    private tail;
    private constructor();
    private get client();
    get issuerAddress(): string;
    private serial;
    static create(transactions: Transactions, wallet: Wallet, operationId: string, maximumAmount?: string): Promise<MptIssuer>;
    static attach(transactions: Transactions, wallet: Wallet, id: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    private banKey;
    private allowed;
    approve(holder: string, operationId: string): Promise<import("./transactions.js").Receipt>;
    mint(holder: string, value: string, operationId: string): Promise<import("./transactions.js").Receipt>;
    clawback(holder: string, value: string, operationId: string): Promise<import("./transactions.js").Receipt>;
    private clawbackInternal;
    setHolderFrozen(holder: string, frozen: boolean, operationId: string): Promise<import("./transactions.js").Receipt>;
    setGlobalFrozen(frozen: boolean, operationId: string): Promise<import("./transactions.js").Receipt>;
    private lock;
    /** Resumable, fail-closed saga. Keep the same operation ID when retrying. No unban API. */
    ban(holder: string, operationId: string): Promise<void>;
}
