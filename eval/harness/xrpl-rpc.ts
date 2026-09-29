// Minimal XRPL JSON-RPC client. The harness reads testnet state over plain
// JSON-RPC instead of xrpl.js so the checker never shares a bug with the SDK
// under test.
import { FAUCET_URL, TESTNET_RPC_URLS } from "./config.ts";
import { sleep } from "./util.ts";

// Thrown when testnet itself (not the agent) is the problem.
export class InfraError extends Error {}

const INFRA_RPC_ERRORS = new Set(["tooBusy", "noNetwork", "noCurrent", "noClosed", "slowDown", "notSynced", "amendmentBlocked"]);

type RpcResult = Record<string, unknown> & { status?: string; error?: string; error_message?: string };

export async function rpc<T = RpcResult>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of TESTNET_RPC_URLS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method, params: [{ api_version: 2, ...params }] }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new InfraError(`${url} ${method}: HTTP ${res.status}`);
        const body = (await res.json()) as { result?: RpcResult };
        const result = body.result;
        if (!result) throw new InfraError(`${url} ${method}: no result`);
        if (result.status === "error" && result.error && INFRA_RPC_ERRORS.has(result.error)) {
          throw new InfraError(`${url} ${method}: ${result.error}`);
        }
        return result as T;
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(2_000 * 2 ** attempt);
  }
  throw lastErr instanceof InfraError ? lastErr : new InfraError(`testnet RPC ${method} failed: ${String(lastErr)}`);
}

export type FundedAccount = { address: string; seed: string; fundedXrp: number; faucetTx: string };

export async function fundAccount(): Promise<FundedAccount> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(FAUCET_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { account?: { classicAddress?: string; address?: string }; seed?: string; amount?: number; transactionHash?: string };
        const address = body.account?.classicAddress ?? body.account?.address;
        if (address && body.seed) {
          await waitForAccount(address);
          const balance = await xrpBalance(address);
          return { address, seed: body.seed, fundedXrp: balance, faucetTx: body.transactionHash ?? "" };
        }
        lastErr = "faucet response missing account or seed";
      } else {
        lastErr = `faucet HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(10_000 * (attempt + 1));
  }
  throw new InfraError(`faucet funding failed: ${lastErr}`);
}

async function waitForAccount(address: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const info = await rpc("account_info", { account: address, ledger_index: "validated" });
    if (info.status === "success") return;
    await sleep(2_000);
  }
  throw new InfraError(`funded account ${address} never appeared in a validated ledger`);
}

export async function xrpBalance(address: string): Promise<number> {
  const info = await rpc<{ account_data?: { Balance?: string } }>("account_info", { account: address, ledger_index: "validated" });
  return Number(info.account_data?.Balance ?? 0) / 1_000_000;
}

export type NetworkSnapshot = {
  at: string;
  rpcUrl: string;
  buildVersion: string;
  networkId: number | undefined;
  validatedLedger: number;
  reserveBaseXrp: number;
  reserveIncXrp: number;
  enabledAmendments: string[];
};

export async function networkSnapshot(): Promise<NetworkSnapshot> {
  const info = await rpc<{ info: { build_version: string; network_id?: number; validated_ledger?: { seq: number; reserve_base_xrp: number; reserve_inc_xrp: number } } }>("server_info");
  const feature = await rpc<{ features?: Record<string, { name?: string; enabled?: boolean }> }>("feature");
  const enabled = Object.entries(feature.features ?? {})
    .filter(([, f]) => f.enabled)
    .map(([hash, f]) => f.name ?? hash)
    .sort();
  return {
    at: new Date().toISOString(),
    rpcUrl: TESTNET_RPC_URLS[0] ?? "",
    buildVersion: info.info.build_version,
    networkId: info.info.network_id,
    validatedLedger: info.info.validated_ledger?.seq ?? 0,
    reserveBaseXrp: info.info.validated_ledger?.reserve_base_xrp ?? 0,
    reserveIncXrp: info.info.validated_ledger?.reserve_inc_xrp ?? 0,
    enabledAmendments: enabled,
  };
}

export type HealthProbe = { at: string; ok: boolean; latencyMs: number; serverState?: string; validatedAgeSec?: number; error?: string };

// One probe of the public endpoint agents are most likely to use.
export async function healthProbe(): Promise<HealthProbe> {
  const started = Date.now();
  const at = new Date().toISOString();
  try {
    const res = await fetch(TESTNET_RPC_URLS[0] ?? "", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "server_info", params: [{}] }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { result?: { info?: { server_state?: string; validated_ledger?: { age?: number } } } };
    const info = body.result?.info;
    const serverState = info?.server_state;
    const validatedAgeSec = info?.validated_ledger?.age;
    const ok = res.ok && serverState !== undefined && ["full", "proposing", "validating"].includes(serverState) && (validatedAgeSec ?? 999) < 60;
    return { at, ok, latencyMs: Date.now() - started, serverState, validatedAgeSec };
  } catch (err) {
    return { at, ok: false, latencyMs: Date.now() - started, error: String(err) };
  }
}

// --- Ledger reads used by the checkers -------------------------------------

export type TxRecord = {
  hash: string;
  ledgerIndex: number;
  txIndex: number;
  validated: boolean;
  result: string;
  tx: Record<string, unknown>;
  meta: Record<string, unknown>;
};

export async function accountTransactions(account: string): Promise<TxRecord[]> {
  const out: TxRecord[] = [];
  let marker: unknown;
  for (let page = 0; page < 50; page++) {
    const res = await rpc<{ status?: string; error?: string; transactions?: Array<Record<string, unknown>>; marker?: unknown }>("account_tx", {
      account,
      ledger_index_min: -1,
      ledger_index_max: -1,
      forward: true,
      limit: 200,
      ...(marker ? { marker } : {}),
    });
    if (res.status === "error") {
      if (res.error === "actNotFound") return out;
      throw new InfraError(`account_tx ${account}: ${res.error}`);
    }
    for (const t of res.transactions ?? []) {
      const tx = (t.tx_json ?? t.tx ?? {}) as Record<string, unknown>;
      const meta = (t.meta ?? {}) as Record<string, unknown>;
      out.push({
        hash: String(t.hash ?? tx.hash ?? ""),
        ledgerIndex: Number(t.ledger_index ?? tx.ledger_index ?? 0),
        txIndex: Number(meta.TransactionIndex ?? 0),
        validated: t.validated === true,
        result: String(meta.TransactionResult ?? ""),
        tx,
        meta,
      });
    }
    if (!res.marker) break;
    marker = res.marker;
  }
  return out.sort((a, b) => a.ledgerIndex - b.ledgerIndex || a.txIndex - b.txIndex);
}

export type MptIssuance = {
  id: string;
  issuer: string;
  flags: number;
  outstanding: bigint;
  assetScale: number;
  raw: Record<string, unknown>;
};

export async function issuancesOf(issuer: string): Promise<MptIssuance[]> {
  const res = await rpc<{ status?: string; error?: string; account_objects?: Array<Record<string, unknown>> }>("account_objects", {
    account: issuer,
    type: "mpt_issuance",
    ledger_index: "validated",
    limit: 400,
  });
  if (res.status === "error") {
    if (res.error === "actNotFound") return [];
    throw new InfraError(`account_objects ${issuer}: ${res.error}`);
  }
  return (res.account_objects ?? []).map((o) => toIssuance(o, issuer));
}

function toIssuance(o: Record<string, unknown>, issuer: string): MptIssuance {
  const id = typeof o.mpt_issuance_id === "string" ? o.mpt_issuance_id : issuanceId(Number(o.Sequence), issuer);
  return {
    id: id.toUpperCase(),
    issuer: String(o.Issuer ?? issuer),
    flags: Number(o.Flags ?? 0),
    outstanding: BigInt(String(o.OutstandingAmount ?? "0")),
    assetScale: Number(o.AssetScale ?? 0),
    raw: o,
  };
}

export async function issuanceById(id: string): Promise<MptIssuance | undefined> {
  const res = await rpc<{ status?: string; error?: string; node?: Record<string, unknown> }>("ledger_entry", {
    mpt_issuance: id,
    ledger_index: "validated",
  });
  if (res.status === "error") {
    if (res.error === "entryNotFound" || res.error === "invalidParams" || res.error === "malformedRequest") return undefined;
    throw new InfraError(`ledger_entry mpt_issuance ${id}: ${res.error}`);
  }
  return res.node ? toIssuance(res.node, String(res.node.Issuer ?? "")) : undefined;
}

export type MpToken = { flags: number; amount: bigint; raw: Record<string, unknown> };

export async function mptokenOf(issuanceIdHex: string, holder: string): Promise<MpToken | undefined> {
  const res = await rpc<{ status?: string; error?: string; node?: Record<string, unknown> }>("ledger_entry", {
    mptoken: { mpt_issuance_id: issuanceIdHex, account: holder },
    ledger_index: "validated",
  });
  if (res.status === "error") {
    if (res.error === "entryNotFound" || res.error === "invalidParams" || res.error === "malformedRequest") return undefined;
    throw new InfraError(`ledger_entry mptoken ${holder}: ${res.error}`);
  }
  if (!res.node) return undefined;
  return { flags: Number(res.node.Flags ?? 0), amount: BigInt(String(res.node.MPTAmount ?? "0")), raw: res.node };
}

// MPTokenIssuanceID = 32-bit big-endian sequence followed by the 160-bit issuer AccountID.
export function issuanceId(sequence: number, issuer: string): string {
  return (sequence.toString(16).padStart(8, "0") + accountIdHex(issuer)).toUpperCase();
}

const XRPL_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

export function accountIdHex(address: string): string {
  let n = 0n;
  for (const ch of address) {
    const v = XRPL_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid address character in ${address}`);
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let leading = 0;
  for (const ch of address) {
    if (ch !== XRPL_ALPHABET[0]) break;
    leading++;
  }
  const bytes = "00".repeat(leading) + hex;
  // version byte (1) + account id (20) + checksum (4)
  if (bytes.length !== 50) throw new Error(`unexpected decoded length for ${address}`);
  return bytes.slice(2, 42).toUpperCase();
}

export const isClassicAddress = (s: unknown): s is string => typeof s === "string" && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s);
export const isIssuanceId = (s: unknown): s is string => typeof s === "string" && /^[0-9A-Fa-f]{48}$/.test(s);
