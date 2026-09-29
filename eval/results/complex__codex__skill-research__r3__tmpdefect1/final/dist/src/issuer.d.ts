import { type Wallet, type MPTokenIssuanceCreate, type Payment } from 'xrpl';
import { Ledger } from './ledger.js';
export declare const CAPABILITIES: number;
export declare const MAX_AMOUNT: string;
export declare function amount(value: string): string;
export declare function holderAddress(value: string, issuer: string): string;
export declare function creation(account: string, maximum: string, scale: number): MPTokenIssuanceCreate;
/** KYC is off-ledger. DepositAuth with NO preauthorizations closes the lock redemption exception. */
export declare class MptIssuer {
    readonly ledger: Ledger;
    private readonly signer;
    readonly issuanceId: string;
    constructor(ledger: Ledger, signer: Wallet, issuanceId: string);
    get address(): string;
    static create(ledger: Ledger, signer: Wallet, id: string, maximum?: string, scale?: number): Promise<MptIssuer>;
    issuance(ledgerHash?: string): Promise<import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance>;
    holder(holder: string, ledgerHash?: string): Promise<{
        index: string;
        PreviousTxnID: string;
        PreviousTxnLgrSeq: number;
        LedgerEntryType: 'MPToken';
        MPTokenIssuanceID: string;
        Flags: number;
        OwnerNode?: string;
        LockedAmount?: string;
        ConfidentialBalanceInbox?: string;
        ConfidentialBalanceSpending?: string;
        ConfidentialBalanceVersion?: number;
        IssuerEncryptedBalance?: string;
        AuditorEncryptedBalance?: string;
        HolderEncryptionKey?: string;
        Sponsor?: string;
        MPTAmount: string;
    } | undefined>;
    assertProfile(): Promise<void>;
    private allowed;
    private setLock;
    approve(id: string, holder: string, kycReference: string): Promise<void>;
    mint(id: string, holder: string, value: string): Promise<void>;
    payment(sender: string, destination: string, value: string): Payment;
    clawback(id: string, holder: string, value: string): Promise<void>;
    freeze(id: string, holder: string, locked?: boolean): Promise<void>;
    globalFreeze(id: string, locked?: boolean): Promise<void>;
    /** Resumable saga: durable ban -> revoke -> lock -> drain -> verify. Completion guarantees zero.
     * Escrow, trading and confidential balances are disabled by this issuance profile.
     */
    ban(id: string, holder: string, reason: string): Promise<void>;
}
