import { Client } from 'xrpl';
export interface Result {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare const ISSUER = "rfVyKGDbMdUjJCJ1z9Qd8JBGQnyR7WQeXb";
export declare function verify(client: Client, result: Result): Promise<unknown>;
