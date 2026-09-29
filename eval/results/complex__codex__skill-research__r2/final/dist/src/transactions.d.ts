import { Client, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import { Store } from './store.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export interface Signer {
    readonly classicAddress: string;
    sign(tx: SubmittableTransaction): {
        tx_blob: string;
        hash: string;
    } | Promise<{
        tx_blob: string;
        hash: string;
    }>;
}
export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    meta: TransactionMetadata;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class UnresolvedTransaction extends Error {
    readonly hash: string;
    readonly lastLedger: number;
    constructor(hash: string, lastLedger: number, options?: ErrorOptions);
}
export declare function checkTestnet(client: Client): Promise<{
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
/** Persists signed bytes BEFORE submission. Same ID + same payload never signs twice. */
export declare class TransactionRunner {
    readonly client: Client;
    readonly store: Store;
    private readonly queue;
    private readonly controls;
    constructor(client: Client, store: Store);
    control<T>(account: string, work: () => Promise<T>): Promise<T>;
    audit(): {
        operationId: string;
        hash: string;
        lastLedger: number;
        receipt?: Receipt;
    }[];
    send(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
    private success;
}
