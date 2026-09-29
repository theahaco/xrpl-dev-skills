import { type Client, type Wallet } from 'xrpl';
import { type Logger, type ValidatedTransaction } from './submitter.js';
/**
 * Actions a token holder takes on their own account. This is not part of the
 * issuer backend: the demo and tests use it to act as the holders.
 */
export declare class MptHolder {
    #private;
    readonly wallet: Wallet;
    readonly issuanceId: string;
    readonly assetScale: number;
    constructor(client: Client, wallet: Wallet, issuanceId: string, assetScale: number, logger?: Logger);
    get address(): string;
    /** Creates the holder's MPToken entry (costs one owner reserve). The issuer must still approve it. */
    optIn(): Promise<ValidatedTransaction>;
    /** Deletes the holder's MPToken entry. Only possible with a zero balance. */
    optOut(): Promise<ValidatedTransaction>;
    send(destination: string, amount: string): Promise<ValidatedTransaction>;
}
