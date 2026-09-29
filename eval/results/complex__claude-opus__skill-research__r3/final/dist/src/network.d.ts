import { Client, Wallet } from 'xrpl';
declare const NETWORKS: {
    readonly mainnet: {
        readonly url: 'wss://xrplcluster.com';
        readonly networkId: 0;
    };
    readonly testnet: {
        readonly url: 'wss://s.altnet.rippletest.net:51233';
        readonly networkId: 1;
    };
    readonly devnet: {
        readonly url: 'wss://s.devnet.rippletest.net:51233';
        readonly networkId: 2;
    };
};
export type NetworkName = keyof typeof NETWORKS;
export interface NetworkConfig {
    url: string;
    /** Expected network_id. The connection is refused if the server reports another. */
    networkId: number;
}
export declare function resolveNetwork(name: string): NetworkConfig;
/** Connects and verifies the server is on the expected network, so we never sign for the wrong chain. */
export declare function connect(network: NetworkConfig): Promise<Client>;
/**
 * Loads a wallet from a family seed. The key algorithm follows the seed prefix
 * (`sEd…` = ed25519), as in xrpl.js v5. If `expectedAddress` is given, the
 * derived address must match it.
 */
export declare function walletFromSeed(seed: string, expectedAddress?: string): Wallet;
export {};
