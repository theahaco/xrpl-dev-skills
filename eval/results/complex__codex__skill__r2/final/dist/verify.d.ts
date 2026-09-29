import { Client } from 'xrpl';
export declare const ISSUER_ADDRESS = "rHHvDzJXJZWgUoU2qijyBxQnXeBXd8EhD5";
export interface DemoResult {
    issuanceId: string;
    holders: Record<'A' | 'B' | 'C', string>;
}
export declare function verify(client: Client, result: DemoResult): Promise<void>;
