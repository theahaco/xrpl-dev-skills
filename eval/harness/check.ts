// Per-task ledger checkers. They read validated testnet state for the issuer
// account the harness created and decide pass/fail per criterion. The agent's
// result.json only tells the checker where to look; every claim in it is
// verified against the ledger.
import type { Tier } from "./config.ts";
import { readFileInside } from "./util.ts";
import {
  accountTransactions,
  InfraError,
  isClassicAddress,
  isIssuanceId,
  issuanceById,
  issuancesOf,
  mptokenOf,
  type MpToken,
  type MptIssuance,
  type TxRecord,
} from "./xrpl-rpc.ts";

// MPTokenIssuance ledger flags
const lsfMPTLocked = 0x01;
const lsfMPTCanLock = 0x02;
const lsfMPTRequireAuth = 0x04;
const lsfMPTCanClawback = 0x40;
// MPToken ledger flags
const lsfMPTokenLocked = 0x01;
const lsfMPTAuthorized = 0x02;
// MPTokenIssuanceSet transaction flags
const tfMPTLock = 0x01;
const tfMPTUnlock = 0x02;
// MPTokenAuthorize transaction flags
const tfMPTUnauthorize = 0x01;

export type Criterion = { id: string; pass: boolean; detail: string };
export type CheckResult = {
  tier: Tier;
  issuer: string;
  checkedAt: string;
  status: "pass" | "fail" | "infra_error";
  criteria: Criterion[];
  infraError?: string;
  observed: Record<string, unknown>;
};

export type Ctx = { issuer: string; txs: TxRecord[]; issuance?: MptIssuance; scale: bigint };

const ok = (c: Criterion[], id: string, pass: boolean, detail: string): void => {
  c.push({ id, pass, detail });
};

function readResultJson(projectDir: string): { value?: Record<string, unknown>; error?: string } {
  const text = readFileInside(projectDir, `${projectDir}/result.json`, 1_000_000);
  if (text === undefined) return { error: "result.json not found (or not a regular file inside the project)" };
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "result.json is not a JSON object" };
    return { value: value as Record<string, unknown> };
  } catch (err) {
    return { error: `result.json does not parse: ${String(err)}` };
  }
}

const succeeded = (t: TxRecord): boolean => t.validated && t.result === "tesSUCCESS";
const flagsOf = (t: TxRecord): number => Number(t.tx.Flags ?? 0);

type MptAmount = { mpt_issuance_id: string; value: string };
function mptAmount(v: unknown, issuanceIdHex: string): bigint | undefined {
  if (!v || typeof v !== "object") return undefined;
  const a = v as Partial<MptAmount>;
  if (typeof a.mpt_issuance_id !== "string" || a.mpt_issuance_id.toUpperCase() !== issuanceIdHex) return undefined;
  try {
    return BigInt(String(a.value));
  } catch {
    return undefined;
  }
}

// MPT delivered to `holder` by validated, successful issuer payments.
export function deliveredTo(ctx: Ctx, holder: string): bigint {
  const id = ctx.issuance?.id ?? "";
  let total = 0n;
  for (const t of ctx.txs) {
    if (!succeeded(t) || t.tx.TransactionType !== "Payment" || t.tx.Account !== ctx.issuer || t.tx.Destination !== holder) continue;
    total += mptAmount(t.meta.delivered_amount ?? t.tx.DeliverMax ?? t.tx.Amount, id) ?? 0n;
  }
  return total;
}

function clawedBackFrom(ctx: Ctx, holder: string): bigint {
  const id = ctx.issuance?.id ?? "";
  let total = 0n;
  for (const t of ctx.txs) {
    if (!succeeded(t) || t.tx.TransactionType !== "Clawback" || t.tx.Account !== ctx.issuer || t.tx.Holder !== holder) continue;
    total += mptAmount(t.tx.Amount, id) ?? 0n;
  }
  return total;
}

function issuanceSets(ctx: Ctx, holder: string | undefined): Array<{ lock: boolean; ledger: number; hash: string }> {
  const id = ctx.issuance?.id ?? "";
  return ctx.txs
    .filter((t) => succeeded(t) && t.tx.TransactionType === "MPTokenIssuanceSet" && String(t.tx.MPTokenIssuanceID ?? "").toUpperCase() === id)
    .filter((t) => (holder === undefined ? t.tx.Holder === undefined : t.tx.Holder === holder))
    .filter((t) => (flagsOf(t) & (tfMPTLock | tfMPTUnlock)) !== 0)
    .map((t) => ({ lock: (flagsOf(t) & tfMPTLock) !== 0, ledger: t.ledgerIndex, hash: t.hash }));
}

// True when a lock is followed by an unlock.
function lockThenUnlock(sets: Array<{ lock: boolean }>): boolean {
  const firstLock = sets.findIndex((s) => s.lock);
  return firstLock >= 0 && sets.slice(firstLock + 1).some((s) => !s.lock);
}

// "1,000 of the token" in display units: raw = 1000 × 10^AssetScale.
const tokens = (ctx: Ctx, n: number): bigint => BigInt(n) * ctx.scale;
const fmt = (ctx: Ctx, raw: bigint): string => (ctx.scale === 1n ? `${raw}` : `${raw} raw (scale ${ctx.scale.toString().length - 1})`);

// Accepts either the raw integer string or the display value.
function sameAmount(ctx: Ctx, claimed: unknown, raw: bigint): boolean {
  if (typeof claimed !== "string" && typeof claimed !== "number") return false;
  const s = String(claimed).replace(/,/g, "").trim();
  if (s === raw.toString()) return true;
  const n = Number(s);
  return Number.isFinite(n) && ctx.scale > 1n && Math.abs(n * Number(ctx.scale) - Number(raw)) < 1e-6;
}

async function loadCtx(issuer: string, claimedId: unknown): Promise<Ctx & { issuanceSource: string }> {
  const txs = await accountTransactions(issuer);
  let issuance: MptIssuance | undefined;
  let issuanceSource = "none";
  if (isIssuanceId(claimedId)) {
    issuance = await issuanceById(claimedId.toUpperCase());
    if (issuance && issuance.issuer !== issuer) issuance = undefined;
    if (issuance) issuanceSource = "result.json";
  }
  if (!issuance) {
    const all = await issuancesOf(issuer);
    issuance = all.find((i) => i.outstanding > 0n) ?? all[0];
    if (issuance) issuanceSource = "discovered";
  }
  return { issuer, txs, issuance, scale: 10n ** BigInt(issuance?.assetScale ?? 0), issuanceSource };
}

function paidHolders(ctx: Ctx): string[] {
  const id = ctx.issuance?.id ?? "";
  const seen = new Set<string>();
  for (const t of ctx.txs) {
    if (!succeeded(t) || t.tx.TransactionType !== "Payment" || t.tx.Account !== ctx.issuer) continue;
    if (mptAmount(t.tx.Amount ?? t.tx.DeliverMax, id) !== undefined) seen.add(String(t.tx.Destination));
  }
  return [...seen];
}

export async function checkRun(tier: Tier, issuer: string, projectDir: string): Promise<CheckResult> {
  const base = { tier, issuer, checkedAt: new Date().toISOString() };
  try {
    const { criteria, observed } = tier === "medium" ? await checkMedium(issuer, projectDir) : await checkComplex(issuer, projectDir);
    return { ...base, status: criteria.every((c) => c.pass) ? "pass" : "fail", criteria, observed };
  } catch (err) {
    if (err instanceof InfraError) return { ...base, status: "infra_error", criteria: [], infraError: err.message, observed: {} };
    throw err;
  }
}

async function checkMedium(issuer: string, projectDir: string): Promise<{ criteria: Criterion[]; observed: Record<string, unknown> }> {
  const c: Criterion[] = [];
  const res = readResultJson(projectDir);
  const r = res.value ?? {};
  const shapeOk = !res.error && isIssuanceId(r.issuanceId) && isClassicAddress(r.holder) && r.holderBalance !== undefined && r.outstandingAmount !== undefined;
  ok(c, "result_json", shapeOk, res.error ?? (shapeOk ? "has issuanceId, holder, holderBalance, outstandingAmount" : `missing or malformed fields: ${JSON.stringify(r).slice(0, 300)}`));

  const ctx = await loadCtx(issuer, r.issuanceId);
  const iss = ctx.issuance;
  ok(c, "issuance_exists", iss !== undefined, iss ? `issuance ${iss.id} (${ctx.issuanceSource})` : "no MPTokenIssuance owned by the issuer");
  if (!iss) return { criteria: c, observed: { txCount: ctx.txs.length } };

  ok(c, "requires_approval", (iss.flags & lsfMPTRequireAuth) !== 0, `issuance flags 0x${iss.flags.toString(16)}; lsfMPTRequireAuth ${(iss.flags & lsfMPTRequireAuth) !== 0 ? "set" : "not set"}`);

  const holder = isClassicAddress(r.holder) ? r.holder : paidHolders(ctx)[0];
  if (!holder) {
    ok(c, "holder_authorized", false, "no holder found in result.json or in issuer payments");
    return { criteria: c, observed: { issuance: iss.raw } };
  }
  const token = await mptokenOf(iss.id, holder);
  ok(c, "holder_authorized", token !== undefined && (token.flags & lsfMPTAuthorized) !== 0, token ? `MPToken flags 0x${token.flags.toString(16)}` : `no MPToken for ${holder}`);

  const want = tokens(ctx, 1000);
  const balance = token?.amount ?? 0n;
  ok(c, "holder_balance_1000", balance === want, `holder balance ${fmt(ctx, balance)}; expected ${fmt(ctx, want)}`);

  // The issuer itself must have paid the full amount: a balance topped up by
  // another holder does not count.
  const paid = deliveredTo(ctx, holder);
  ok(c, "payment_validated", paid === want, `validated tesSUCCESS issuer→holder MPT payments delivered ${fmt(ctx, paid)}; expected ${fmt(ctx, want)}`);

  ok(c, "outstanding_matches", iss.outstanding === balance, `OutstandingAmount ${fmt(ctx, iss.outstanding)}; holder balance ${fmt(ctx, balance)}`);

  const readBack = sameAmount(ctx, r.holderBalance, balance) && sameAmount(ctx, r.outstandingAmount, iss.outstanding);
  ok(c, "readback_matches_ledger", readBack, `result.json holderBalance=${JSON.stringify(r.holderBalance)} outstandingAmount=${JSON.stringify(r.outstandingAmount)}; ledger ${balance} / ${iss.outstanding}`);

  return { criteria: c, observed: { issuance: iss.raw, holder, mptoken: token?.raw, txCount: ctx.txs.length } };
}

async function checkComplex(issuer: string, projectDir: string): Promise<{ criteria: Criterion[]; observed: Record<string, unknown> }> {
  const c: Criterion[] = [];
  const res = readResultJson(projectDir);
  const r = res.value ?? {};
  const claimed = (r.holders && typeof r.holders === "object" ? r.holders : {}) as Record<string, unknown>;
  const shapeOk = !res.error && isIssuanceId(r.issuanceId) && ["A", "B", "C"].every((k) => isClassicAddress(claimed[k]));
  ok(c, "result_json", shapeOk, res.error ?? (shapeOk ? "has issuanceId and holders A, B, C" : `missing or malformed fields: ${JSON.stringify(r).slice(0, 300)}`));

  const ctx = await loadCtx(issuer, r.issuanceId);
  const iss = ctx.issuance;
  ok(c, "issuance_exists", iss !== undefined, iss ? `issuance ${iss.id} (${ctx.issuanceSource})` : "no MPTokenIssuance owned by the issuer");
  if (!iss) return { criteria: c, observed: { txCount: ctx.txs.length } };

  const caps = { canLock: (iss.flags & lsfMPTCanLock) !== 0, requireAuth: (iss.flags & lsfMPTRequireAuth) !== 0, canClawback: (iss.flags & lsfMPTCanClawback) !== 0 };
  ok(c, "issuance_capabilities", caps.canLock && caps.requireAuth && caps.canClawback, `flags 0x${iss.flags.toString(16)}: ${JSON.stringify(caps)}`);

  const holders = await resolveRoles(ctx, claimed);
  const tokensByRole: Record<string, MpToken | undefined> = {};
  for (const role of ["A", "B", "C"] as const) {
    const addr = holders[role];
    tokensByRole[role] = addr ? await mptokenOf(iss.id, addr) : undefined;
  }
  const bal = (role: string): bigint => tokensByRole[role]?.amount ?? 0n;
  const flags = (role: string): number => tokensByRole[role]?.flags ?? 0;
  const describe = (role: string): string =>
    holders[role] ? `${holders[role]}: ${tokensByRole[role] ? `balance ${fmt(ctx, bal(role))}, flags 0x${flags(role).toString(16)}` : "no MPToken"}` : "holder not identified";

  // Holder A
  const aOk = holders.A !== undefined && (flags("A") & lsfMPTAuthorized) !== 0 && bal("A") === tokens(ctx, 500) && (flags("A") & lsfMPTokenLocked) === 0;
  ok(c, "holder_a_state", aOk, `${describe("A")}; expected authorized, ${fmt(ctx, tokens(ctx, 500))}, not locked`);
  const aSets = holders.A ? issuanceSets(ctx, holders.A) : [];
  ok(c, "holder_a_freeze_cycle", lockThenUnlock(aSets), `per-holder lock/unlock on A: ${aSets.map((s) => (s.lock ? "lock" : "unlock")).join(", ") || "none"}`);

  // Holder B
  const bOk = holders.B !== undefined && (flags("B") & lsfMPTAuthorized) !== 0 && bal("B") === tokens(ctx, 700) && (flags("B") & lsfMPTokenLocked) !== 0;
  ok(c, "holder_b_state", bOk, `${describe("B")}; expected authorized, ${fmt(ctx, tokens(ctx, 700))}, locked`);
  const bPaid = holders.B ? deliveredTo(ctx, holders.B) : 0n;
  ok(c, "holder_b_sent_1000", bPaid === tokens(ctx, 1000), `issuer delivered ${fmt(ctx, bPaid)} to B`);
  const bClaw = holders.B ? clawedBackFrom(ctx, holders.B) : 0n;
  ok(c, "holder_b_clawback_300", bClaw === tokens(ctx, 300), `validated Clawback from B totals ${fmt(ctx, bClaw)}`);

  // Holder C
  const cToken = tokensByRole.C;
  const cBanned = holders.C !== undefined && bal("C") === 0n && (cToken === undefined || (cToken.flags & lsfMPTAuthorized) === 0) && caps.requireAuth;
  ok(c, "holder_c_banned", cBanned, `${describe("C")}; expected zero balance and no issuer authorization on a require-auth issuance`);
  const cPaid = holders.C ? deliveredTo(ctx, holders.C) : 0n;
  ok(c, "holder_c_received_before_ban", cPaid > 0n, `issuer delivered ${fmt(ctx, cPaid)} to C`);
  const cUnauth = ctx.txs.some(
    (t) => succeeded(t) && t.tx.TransactionType === "MPTokenAuthorize" && t.tx.Account === issuer && t.tx.Holder === holders.C && (flagsOf(t) & tfMPTUnauthorize) !== 0,
  );

  // Global freeze
  const gSets = issuanceSets(ctx, undefined);
  ok(c, "global_freeze_cycle", lockThenUnlock(gSets), `issuance-wide lock/unlock: ${gSets.map((s) => (s.lock ? "lock" : "unlock")).join(", ") || "none"}`);
  ok(c, "not_globally_frozen", (iss.flags & lsfMPTLocked) === 0, `issuance lsfMPTLocked ${(iss.flags & lsfMPTLocked) !== 0 ? "set" : "clear"}`);

  const sum = bal("A") + bal("B") + bal("C");
  ok(c, "outstanding_consistent", iss.outstanding === sum, `OutstandingAmount ${fmt(ctx, iss.outstanding)}; A+B+C ${fmt(ctx, sum)}`);

  return {
    criteria: c,
    observed: { issuance: iss.raw, holders, holderTokens: Object.fromEntries(Object.entries(tokensByRole).map(([k, v]) => [k, v?.raw])), cUnauthorizedByIssuer: cUnauth, txCount: ctx.txs.length },
  };
}

// Uses result.json's mapping when it names real holders, otherwise infers roles
// from the final state so the rest of the criteria still carry signal.
async function resolveRoles(ctx: Ctx, claimed: Record<string, unknown>): Promise<Record<string, string | undefined>> {
  const roles: Record<string, string | undefined> = {};
  for (const role of ["A", "B", "C"]) roles[role] = isClassicAddress(claimed[role]) ? claimed[role] : undefined;
  if (roles.A && roles.B && roles.C) return roles;
  const iss = ctx.issuance;
  if (!iss) return roles;
  const taken = new Set(Object.values(roles).filter(Boolean));
  for (const addr of paidHolders(ctx)) {
    if (taken.has(addr)) continue;
    const t = await mptokenOf(iss.id, addr);
    const amount = t?.amount ?? 0n;
    const locked = ((t?.flags ?? 0) & lsfMPTokenLocked) !== 0;
    const role = amount === tokens(ctx, 500) && !locked ? "A" : amount === tokens(ctx, 700) ? "B" : amount === 0n ? "C" : undefined;
    if (role && !roles[role]) {
      roles[role] = addr;
      taken.add(addr);
    }
  }
  return roles;
}
