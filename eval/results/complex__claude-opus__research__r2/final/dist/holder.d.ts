import type { Client, Wallet } from 'xrpl';
import { type ValidatedTx } from './ledger.js';
/**
 * Holder-side operations. The issuer never holds these keys. These helpers exist
 * so that wallets, tests and the demo can play the holder's part.
 */
/** Opts in to holding an MPT by creating the holder's MPToken entry (costs one owner reserve). */
export declare function optIn(client: Client, holder: Wallet, issuanceId: string, expectedNetworkId: number): Promise<ValidatedTx>;
/**
 * Sends MPT from a holder. Resolves with the validated result even if the
 * transaction failed (for example tecLOCKED or tecNO_AUTH), so callers can check
 * `resultCode`.
 */
export declare function sendMpt(client: Client, from: Wallet, destination: string, issuanceId: string, baseUnits: bigint, expectedNetworkId: number): Promise<ValidatedTx>;
