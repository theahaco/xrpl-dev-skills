import type { Client } from 'xrpl';
export interface DemoResult {
    issuanceId: string;
    holders: Record<'A' | 'B' | 'C', string>;
}
export declare const ISSUER_ADDRESS = "rJ1UNnBGHY83XddoTMZstNKMvH6Esvi9Mx";
export declare function verify(client: Client, result: DemoResult): Promise<unknown>;
