import { DatabaseSync } from 'node:sqlite';
import { Client, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare function invariant(condition: unknown, message: string): asserts condition;
export declare class Serial {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
export declare function rpcCode(error: unknown): string | undefined;
export interface Receipt {
    hash: string;
    ledger: number;
    code: string;
    meta: TransactionMetadata;
}
/** One durable journal and one process per issuer. Never delete a pending operation. */
export declare class Journal {
    readonly db: DatabaseSync;
    private readonly lock;
    constructor(path: string);
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    banned(id: string, holder: string): boolean;
    ban(id: string, holder: string, reason: string): void;
    close(): void;
}
export declare class TransactionFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export interface Signer {
    address: string;
    sign(tx: SubmittableTransaction): {
        tx_blob: string;
        hash: string;
    };
}
export declare class Runner {
    readonly client: Client;
    readonly journal: Journal;
    private readonly serial;
    constructor(client: Client, journal: Journal);
    preflight(): Promise<{
        server: {
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
    }>;
    execute(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
}
