/**
 * Holder-side actions. These are signed by the holder, not the issuer; the
 * backend doesn't need them in production, but the demo and integration tests
 * use them to act as holders.
 */
import { type Client, type Wallet } from 'xrpl';
import { type ValidatedTransaction } from './ledger.js';
/** Opt in to holding an MPT (creates the holder's MPToken entry). Required before the issuer can authorize them. */
export declare function optIn(client: Client, holder: Wallet, issuanceId: string): Promise<ValidatedTransaction>;
/** Opt out (delete the holder's MPToken entry). Only possible with a zero balance. */
export declare function optOut(client: Client, holder: Wallet, issuanceId: string): Promise<ValidatedTransaction>;
/** Send `rawAmount` (on-ledger integer units) of the MPT to another account. */
export declare function transfer(client: Client, holder: Wallet, destination: string, issuanceId: string, rawAmount: bigint): Promise<ValidatedTransaction>;
