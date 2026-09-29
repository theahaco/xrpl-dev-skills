import { Client } from 'xrpl';
export interface DemoResult {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function verify(client: Client, result: DemoResult): Promise<void>;
