import { Client, type SubmittableTransaction, type LedgerEntry, type Wallet, type TxResponse, type LedgerEntryRequest } from 'xrpl';
import { Journal } from './journal.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const AMENDMENTS = "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";
export declare const REQUIRED: readonly ['MPTokensV1', 'Clawback', 'DepositAuth', 'fixMPTDeliveredAmount'];
export declare class LedgerFailure extends Error {
    readonly code: string;
    readonly hash: string;
    constructor(code: string, hash: string);
}
export declare function resultCode(r: TxResponse['result']): string;
export declare function requireSuccess(r: TxResponse['result']): void;
export declare class Ledger {
    readonly client: Client;
    readonly journal: Journal;
    private tail;
    private submissionTail;
    constructor(client: Client, journal: Journal);
    serial<T>(fn: () => Promise<T>): Promise<T>;
    preflight(): Promise<{
        info: {
            amendment_blocked?: boolean;
            build_version: string;
            closed_ledger?: {
                age: number;
                base_fee_xrp: number;
                hash: string;
                reserve_base_xrp: number;
                reserve_inc_xrp: number;
                seq: number;
            };
            complete_ledgers: string;
            hostid: string;
            io_latency_ms: number;
            jq_trans_overflow: string;
            last_close: {
                converge_time_s: number;
                proposers: number;
            };
            load?: {
                job_types: import("xrpl").JobType[];
                threads: number;
            };
            load_factor?: number;
            network_id?: number;
            load_factor_local?: number;
            load_factor_net?: number;
            load_factor_cluster?: number;
            load_factor_fee_escalation?: number;
            load_factor_fee_queue?: number;
            load_factor_server?: number;
            peer_disconnects?: string;
            peer_disconnects_resources?: string;
            network_ledger?: 'waiting';
            peers: number;
            ports: import("xrpl/dist/npm/models/methods/serverInfo.js").ServerPort[];
            pubkey_node: string;
            pubkey_validator?: string;
            server_state: import("xrpl").ServerState;
            server_state_duration_us: string;
            state_accounting: import("xrpl").StateAccountingFinal;
            time: string;
            uptime: number;
            validated_ledger?: {
                age: number;
                base_fee_xrp: number;
                hash: string;
                reserve_base_xrp: number;
                reserve_inc_xrp: number;
                seq: number;
            };
            validation_quorum: number;
            validator_list_expires?: string;
            validator_list?: {
                count: number;
                expiration: 'never' | 'unknown' | string;
                status: 'active' | 'expired' | 'unknown';
            };
        };
        features: Record<string, {
            enabled: boolean;
            name: string;
            supported: boolean;
        }>;
        amendments: LedgerEntry.Amendments;
    }>;
    entry(request: Omit<LedgerEntryRequest, 'command'>): Promise<LedgerEntry.LedgerEntry | LedgerEntry.MPToken | undefined>;
    /** Persist bytes before submission. Retry the SAME id/hash on ambiguous outcomes. */
    send(id: string, wallet: Wallet, tx: SubmittableTransaction): Promise<TxResponse['result']>;
    private sendOnce;
}
