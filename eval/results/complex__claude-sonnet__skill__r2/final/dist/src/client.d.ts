import { Client } from "xrpl";
export declare const TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";
/**
 * Creates a Client pointed at XRPL testnet with a sane fee safety cap.
 * `maxFeeXRP` guards against fee-escalation surprises during congestion;
 * 2 XRP is far above what any of these transactions should ever cost.
 */
export declare function createTestnetClient(maxFeeXRP?: string): Client;
