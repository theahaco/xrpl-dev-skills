// Budget gate. A set (one agent, one tier: every arm and rep) starts only if
// its whole projected cost, scoring included and padded by the margin, still
// leaves the provider's weekly allowance above the floor. Opus and Sonnet both
// draw on the one Claude allowance; the blind model scorer does too.
import fs from "node:fs";
import path from "node:path";
import {
  AGENTS,
  type AgentName,
  ARMS,
  BUDGET_FLOOR_PCT,
  BUDGET_MARGIN,
  BUDGET_WARN_PCT,
  ESTIMATES_PATH,
  type Provider,
  REPS,
  RESULTS_DIR,
  type Tier,
} from "./config.ts";
import { exec, readJson, writeJson } from "./util.ts";

export type QuotaReading = { provider: Provider; percentRemaining: number; windowId: string; resetsAt?: string; readAt: string };

type QuotaJson = { providers?: Array<{ provider: string; windows?: Array<{ id: string; kind: string; percentRemaining: number; resetsAt?: string }> }> };

export async function weeklyQuota(provider: Provider): Promise<QuotaReading> {
  const res = await exec("quota-axi", ["--provider", provider, "--json"]);
  if (res.code !== 0) throw new Error(`quota-axi failed: ${res.stderr.trim() || res.stdout.trim()}`);
  const data = JSON.parse(res.stdout) as QuotaJson;
  const p = data.providers?.find((x) => x.provider === provider);
  const weekly = p?.windows?.find((w) => w.kind === "weekly");
  if (!weekly) throw new Error(`quota-axi reported no weekly window for ${provider}`);
  return { provider, percentRemaining: weekly.percentRemaining, windowId: weekly.id, resetsAt: weekly.resetsAt, readAt: new Date().toISOString() };
}

export type Estimates = {
  // Percent of the provider's weekly allowance one run consumes.
  runs: Partial<Record<AgentName, Partial<Record<Tier, { weeklyPct: number; source: string }>>>>;
  // Claude weekly percent the blind model scorer uses per scored run.
  scoring: { claudeWeeklyPctPerRun: number; source: string };
};

export function loadEstimates(): Estimates {
  return readJson<Estimates>(ESTIMATES_PATH);
}

const RESERVATIONS_DIR = path.join(RESULTS_DIR, ".reservations");

export type Reservation = { set: string; claudePct: number; codexPct: number; pid: number; at: string };

function activeReservations(): Reservation[] {
  if (!fs.existsSync(RESERVATIONS_DIR)) return [];
  const out: Reservation[] = [];
  for (const f of fs.readdirSync(RESERVATIONS_DIR)) {
    const r = readJson<Reservation>(path.join(RESERVATIONS_DIR, f));
    try {
      process.kill(r.pid, 0);
      out.push(r);
    } catch {
      fs.rmSync(path.join(RESERVATIONS_DIR, f), { force: true });
    }
  }
  return out;
}

export function reserve(r: Reservation): () => void {
  const file = path.join(RESERVATIONS_DIR, `${r.set.replace(/[^a-z0-9-]/gi, "_")}.json`);
  writeJson(file, r);
  return () => fs.rmSync(file, { force: true });
}

export type GateDecision = {
  set: string;
  runs: number;
  allowed: boolean;
  lines: string[];
  cost: { claudePct: number; codexPct: number };
  quota: Partial<Record<Provider, QuotaReading>>;
};

export const setName = (agent: AgentName, tier: Tier): string => `${agent}:${tier}`;
export const runsInSet = (tier: Tier): number => ARMS.length * REPS[tier];

// `runs` defaults to a whole set; pass 1 to gate a single run.
export async function gate(agent: AgentName, tier: Tier, opts: { runs?: number; estimatePct?: number } = {}): Promise<GateDecision> {
  const set = setName(agent, tier);
  const runs = opts.runs ?? runsInSet(tier);
  const provider = AGENTS[agent].provider;
  const est = loadEstimates();
  const perRun = opts.estimatePct ?? est.runs[agent]?.[tier]?.weeklyPct;
  const lines: string[] = [];
  if (perRun === undefined) {
    return { set, runs, allowed: false, lines: [`REFUSE ${set}: no per-run estimate for ${agent}/${tier} in budget/estimates.json; run the calibration pass or pass --estimate-pct`], cost: { claudePct: 0, codexPct: 0 }, quota: {} };
  }
  const agentPct = perRun * runs;
  const scoringPct = est.scoring.claudeWeeklyPctPerRun * runs;
  const cost = { claudePct: (provider === "claude" ? agentPct : 0) + scoringPct, codexPct: provider === "codex" ? agentPct : 0 };
  const reserved = activeReservations();
  const quota: Partial<Record<Provider, QuotaReading>> = {};
  let allowed = true;
  for (const p of ["claude", "codex"] as const) {
    const need = p === "claude" ? cost.claudePct : cost.codexPct;
    if (need === 0) continue;
    const q = await weeklyQuota(p);
    quota[p] = q;
    const held = reserved.reduce((s, r) => s + (p === "claude" ? r.claudePct : r.codexPct), 0);
    const projected = q.percentRemaining - held - need * BUDGET_MARGIN;
    const summary = `${p}: ${q.percentRemaining}% weekly remaining, ${held.toFixed(1)}% reserved by running sets, set needs ${need.toFixed(1)}% x${BUDGET_MARGIN} margin -> ${projected.toFixed(1)}% projected (floor ${BUDGET_FLOOR_PCT}%)`;
    if (projected < BUDGET_FLOOR_PCT) {
      allowed = false;
      lines.push(`REFUSE ${set}: ${summary}`);
    } else {
      lines.push(`OK ${set}: ${summary}`);
    }
    if (q.percentRemaining <= BUDGET_WARN_PCT || projected <= BUDGET_WARN_PCT) {
      lines.push(`WARN ${p} weekly allowance at ${q.percentRemaining}% now, ${projected.toFixed(1)}% projected after ${set} (warning threshold ${BUDGET_WARN_PCT}%)`);
    }
  }
  return { set, runs, allowed, lines, cost, quota };
}
