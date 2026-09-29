import { Client } from "xrpl";
export declare const TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";
export declare const TESTNET_FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";
/** Creates a connected xrpl.js Client with a conservative max fee guard. */
export declare function connectTestnetClient(): Promise<Client>;
