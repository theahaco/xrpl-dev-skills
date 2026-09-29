import { type Client } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { TransactionRunner, type Signer, type Receipt } from './transactions.js';
export declare const CAPABILITIES: number;
export declare const MAX_AMOUNT: string;
export declare function amount(value: string): string;
export declare function holderAddress(holder: string, issuer: string): void;
export declare function preflight(client: Client): Promise<{
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
    amendments: import("xrpl/dist/npm/models/ledger/Amendments.js").default;
}>;
/** Ledger-native MPT locks permit issuer/holder payments in both directions. NOT an absolute freeze. */
export declare class MptIssuer {
    readonly runner: TransactionRunner;
    readonly signer: Signer;
    readonly issuanceId: string;
    constructor(runner: TransactionRunner, signer: Signer, issuanceId: string);
    static create(runner: TransactionRunner, signer: Signer, key: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holding(holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    assertConfiguration(): Promise<void>;
    private allowed;
    private authorization;
    /** Only call after your backend's KYC decision. No PII goes onto the ledger. */
    approve(holder: string, key: string): Promise<Receipt>;
    issue(holder: string, value: string, key: string): Promise<Receipt>;
    clawback(holder: string, value: string, key: string): Promise<Receipt>;
    private clawbackInternal;
    private lockInternal;
    freezeHolder(holder: string, locked: boolean, key: string): Promise<Receipt>;
    freezeGlobal(locked: boolean, key: string): Promise<Receipt>;
    /** Resumable saga: durable deny -> revoke authorization -> claw back -> verify.
     * Revocation prevents incoming transfers even if the holder deletes/recreates its object.
     * Redemption remains possible during the saga.
     */
    ban(holder: string, reason: string, key: string): Promise<void>;
}
