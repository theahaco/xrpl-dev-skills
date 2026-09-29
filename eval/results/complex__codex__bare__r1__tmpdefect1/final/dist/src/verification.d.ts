import { type Client } from 'xrpl';
export declare const ISSUER_ADDRESS = "rwtSKPNxCCKaLRpTgpYnWgZ8t2DBw8vXgo";
export declare const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
export interface DemoResult {
    issuanceId: string;
    holders: Record<'A' | 'B' | 'C', string>;
}
export declare function verify(client: Client, result: DemoResult): Promise<unknown>;
