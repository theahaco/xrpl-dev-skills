import type { Client, Wallet } from "xrpl";
import type { HolderState, IssuanceCreateResult, IssuanceParams, IssuanceState, SubmittedTx } from "./types";
/**
 * Issuer-side compliance controls for a Multi-Purpose Token (MPT) issuance
 * on the XRP Ledger: allowlisting, clawback, per-holder freeze, global
 * freeze, and address bans.
 *
 * One instance manages one issuer account. Construct with a connected
 * `Client` and the issuer's `Wallet`; every method signs and submits with
 * that wallet and waits for validation before resolving. Every method
 * throws `IssuerTransactionError` on anything short of `tesSUCCESS` in a
 * validated ledger — callers should not need to inspect result codes
 * themselves.
 */
export declare class MptIssuer {
    private readonly client;
    private readonly issuerWallet;
    constructor(client: Client, issuerWallet: Wallet);
    get address(): string;
    /** Creates a new MPT issuance with allowlist, clawback and lock (freeze) all enabled. */
    createIssuance(params?: IssuanceParams): Promise<IssuanceCreateResult>;
    /**
     * Allowlist: approves a holder to hold this issuance. The holder must
     * already have opted in (see `optInHolder`) before this call succeeds.
     */
    approveHolder(issuanceId: string, holder: string): Promise<SubmittedTx>;
    /**
     * Allowlist: revokes a holder's approval, without touching their balance
     * or freeze state. After this, the holder cannot receive the token again
     * (but keeps whatever balance they already hold, unless separately
     * clawed back). Used internally by `banHolder`.
     */
    revokeHolderApproval(issuanceId: string, holder: string): Promise<SubmittedTx>;
    /** Sends tokens from the issuer to an approved, non-frozen holder. */
    send(issuanceId: string, holder: string, value: string): Promise<SubmittedTx>;
    /** Claws back a specific amount from a holder's balance. */
    clawback(issuanceId: string, holder: string, value: string): Promise<SubmittedTx>;
    /** Claws back a holder's entire current balance. No-op (returns null) if they hold zero. */
    clawbackAll(issuanceId: string, holder: string): Promise<SubmittedTx | null>;
    /** Freezes a single holder: they can neither send nor receive the token. */
    freezeHolder(issuanceId: string, holder: string): Promise<SubmittedTx>;
    /** Lifts a single holder's freeze. */
    unfreezeHolder(issuanceId: string, holder: string): Promise<SubmittedTx>;
    /** Freezes all movement of the token for every holder (emergency stop). */
    globalFreeze(issuanceId: string): Promise<SubmittedTx>;
    /** Lifts the global freeze. */
    globalUnfreeze(issuanceId: string): Promise<SubmittedTx>;
    /**
     * Bans a holder: claws back their entire balance, freezes them, and
     * revokes their allowlist approval so they can never receive the token
     * again. Idempotent-ish — safe to call on a holder who already holds
     * zero, is already frozen, etc.
     */
    banHolder(issuanceId: string, holder: string): Promise<SubmittedTx[]>;
    /** Reads the current compliance-relevant state of the issuance itself. */
    getIssuanceState(issuanceId: string): Promise<IssuanceState>;
    /** Reads the current compliance-relevant state of one holder. */
    getHolderState(issuanceId: string, holder: string): Promise<HolderState>;
    private setLock;
    private submit;
}
