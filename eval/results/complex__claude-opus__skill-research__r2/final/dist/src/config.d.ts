import { Client, Wallet } from 'xrpl';
export interface XrplConfig {
    wsUrl: string;
    networkId: number;
}
export declare function loadXrplConfig(env?: NodeJS.ProcessEnv): XrplConfig;
/**
 * Loads the issuer wallet from ISSUER_SEED. The key algorithm is chosen
 * explicitly from the seed prefix (xrpl.js v5 no longer defaults it), and the
 * derived address must match ISSUER_ADDRESS, so a wrong seed fails before
 * anything is signed.
 */
export declare function loadIssuerWallet(env?: NodeJS.ProcessEnv): Wallet;
/**
 * Connects and checks that the server reports the expected network ID, so
 * nothing is ever signed for the wrong network.
 */
export declare function connectClient(config: XrplConfig): Promise<Client>;
