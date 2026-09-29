import { Client, type SubmittableTransaction, type Transaction } from 'xrpl';
import { Store, Serial } from './store.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export interface Signer {
    readonly classicAddress: string;
    sign(tx: Transaction): {
        tx_blob: string;
        hash: string;
    } | Promise<{
        tx_blob: string;
        hash: string;
    }>;
}
export interface Receipt {
    hash: string;
    ledger: number;
    code: string;
    issuanceId?: string;
}
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class UnresolvedTransaction extends Error {
    readonly hash: string;
    constructor(hash: string, options?: ErrorOptions);
}
export declare function address(value: string): string;
export declare function rpcError(error: unknown): string | undefined;
export declare function preflight(client: Client): Promise<{
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
    enabledAmendments: string[];
}>;
/** Durable idempotency keys, bounded fees and no automatic replacement of ambiguous submissions. */
export declare class Submitter {
    readonly client: Client;
    readonly store: Store;
    private readonly serial;
    readonly operations: Serial;
    constructor(client: Client, store: Store);
    submit(key: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
    receipts(): {
        hash: string;
        ledger: number;
        code: string;
        issuanceId?: string;
        operationId: string;
        transaction: Transaction;
    }[];
}
