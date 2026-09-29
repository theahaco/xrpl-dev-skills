// Entry point: `node harness/cli.ts <command> [flags]`. See eval/README.md.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gate, reserve, runsInSet, setName } from "./budget.ts";
import { checkRun } from "./check.ts";
import {
  AGENT_NAMES,
  AGENTS,
  type AgentName,
  ARMS,
  DEFAULT_CONCURRENCY,
  MAX_INFRA_RERUNS,
  REPS,
  RESULTS_DIR,
  SANDBOX_ROOT,
  type Tier,
  TIERS,
} from "./config.ts";
import { classify } from "./infra.ts";
import { agentErrorTexts, type RunRecord, type RunSpec, runId, runOne } from "./run.ts";
import { agentEnv, createWorkspace, isolationSelfTest, linkToolchain, resolveToolchain, writeProfile } from "./sandbox.ts";
import { agreement, scoreRun } from "./score.ts";
import { log, randomHex, readJson, readJsonIfExists, writeJson } from "./util.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    tier: { type: "string" },
    arm: { type: "string" },
    rep: { type: "string" },
    sets: { type: "string" },
    concurrency: { type: "string" },
    "estimate-pct": { type: "string" },
    "keep-workspace": { type: "boolean" },
    "no-gate": { type: "boolean" },
    calibrate: { type: "boolean" },
  },
});

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[]): T {
  if (!v || !allowed.includes(v as T)) throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function positiveInt(name: string, v: string | undefined, fallback: number): number {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

const estimatePct = values["estimate-pct"] !== undefined ? Number(values["estimate-pct"]) : undefined;
if (estimatePct !== undefined && !(Number.isFinite(estimatePct) && estimatePct >= 0)) throw new Error("--estimate-pct must be a non-negative number");

async function runWithReruns(spec: RunSpec, keepWorkspace: boolean): Promise<RunRecord> {
  const id = runId(spec);
  const outDir = path.join(RESULTS_DIR, id);
  let rerunOf: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const rec = await runOne(spec, { attempt, rerunOf, keepWorkspace });
    if (rec.status !== "infra" || attempt > MAX_INFRA_RERUNS) return rec;
    const aside = `${outDir}__infra${attempt}`;
    fs.renameSync(outDir, aside);
    rerunOf = path.basename(aside);
    log(`${id}: infrastructure failure (${rec.infra?.reasons.join("; ")}); re-running, flagged as rerun of ${rerunOf}`);
  }
}

function printGate(lines: string[]): void {
  for (const l of lines) console.log(l);
}

async function cmdRun(): Promise<void> {
  const spec: RunSpec = {
    agent: oneOf("agent", values.agent, AGENT_NAMES),
    tier: oneOf("tier", values.tier, TIERS),
    arm: oneOf("arm", values.arm, ARMS),
    rep: positiveInt("rep", values.rep, 1),
  };
  if (!values["no-gate"]) {
    const decision = await gate(spec.agent, spec.tier, { runs: 1, estimatePct });
    printGate(decision.lines);
    if (!decision.allowed) process.exit(3);
  }
  const rec = await runWithReruns(spec, values["keep-workspace"] === true);
  console.log(JSON.stringify({ runId: rec.runId, status: rec.status, check: rec.check, infra: rec.infra?.verdict, model: rec.agentInfo?.model, agentSeconds: rec.agentSeconds, usage: rec.usage, error: rec.error }, null, 2));
  if (rec.status === "error") process.exit(1);
}

type SetSpec = { agent: AgentName; tier: Tier };

function parseSets(): SetSpec[] {
  if (values.sets) {
    return values.sets.split(",").map((s) => {
      const [agent, tier] = s.split(":");
      return { agent: oneOf("sets agent", agent, AGENT_NAMES), tier: oneOf("sets tier", tier, TIERS) };
    });
  }
  return [{ agent: oneOf("agent", values.agent, AGENT_NAMES), tier: oneOf("tier", values.tier, TIERS) }];
}

async function cmdSet(): Promise<void> {
  const sets = parseSets();
  const releases: Array<() => void> = [];
  for (const s of sets) {
    const decision = await gate(s.agent, s.tier, { estimatePct });
    printGate(decision.lines);
    if (!decision.allowed) {
      for (const r of releases) r();
      process.exit(3);
    }
    // Later sets in the same invocation see this one's reservation.
    releases.push(reserve({ set: setName(s.agent, s.tier), claudePct: decision.cost.claudePct, codexPct: decision.cost.codexPct, pid: process.pid, at: new Date().toISOString() }));
  }
  const queue: RunSpec[] = [];
  for (const s of sets) {
    for (let rep = 1; rep <= REPS[s.tier]; rep++) {
      for (const arm of ARMS) {
        const spec = { agent: s.agent, tier: s.tier, arm, rep };
        const dir = path.join(RESULTS_DIR, runId(spec));
        const prior = readJsonIfExists<RunRecord>(path.join(dir, "run.json"));
        if (prior && prior.status !== "error") {
          log(`${runId(spec)}: already has results (${prior.status}), skipping`);
          continue;
        }
        if (fs.existsSync(dir)) {
          // A harness error or an interrupted run: keep it for inspection, run again.
          let n = 1;
          while (fs.existsSync(`${dir}__aborted${n}`)) n++;
          fs.renameSync(dir, `${dir}__aborted${n}`);
          log(`${runId(spec)}: previous attempt ${prior ? "errored" : "was interrupted"}; moved to __aborted${n}, running again`);
        }
        queue.push(spec);
      }
    }
  }
  const concurrency = positiveInt("concurrency", values.concurrency, DEFAULT_CONCURRENCY);
  log(`running ${queue.length} runs, ${concurrency} at a time`);
  const summary: Array<Pick<RunRecord, "runId" | "status" | "check" | "error">> = [];
  const worker = async (): Promise<void> => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      try {
        const rec = await runWithReruns(spec, values["keep-workspace"] === true);
        summary.push({ runId: rec.runId, status: rec.status, check: rec.check, error: rec.error });
      } catch (err) {
        summary.push({ runId: runId(spec), status: "error", error: String(err) });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    for (const r of releases) r();
  }
  console.log(JSON.stringify(summary, null, 2));
}

function runDirsFrom(args: string[]): string[] {
  const dirs = args.length ? args : fs.readdirSync(RESULTS_DIR).map((d) => path.join(RESULTS_DIR, d));
  return dirs.filter((d) => fs.existsSync(path.join(d, "run.json")));
}

// Re-reads the ledger for finished runs, e.g. after a checker infra error.
async function cmdCheck(args: string[]): Promise<void> {
  for (const dir of runDirsFrom(args)) {
    const rec = readJson<RunRecord>(path.join(dir, "run.json"));
    if (!rec.account) continue;
    const check = await checkRun(rec.tier, rec.account.address, path.join(dir, "final"));
    writeJson(path.join(dir, "check.json"), check);
    rec.check = { status: check.status, failed: check.criteria.filter((c) => !c.pass).map((c) => c.id) };
    rec.infra = classify({ check, transcriptFile: path.join(dir, "transcript", "agent.jsonl"), probes: readProbes(dir), agentErrors: agentErrorTexts(rec, path.join(dir, "transcript")) });
    rec.status = rec.infra.verdict === "infra" ? "infra" : "complete";
    writeJson(path.join(dir, "infra.json"), rec.infra);
    writeJson(path.join(dir, "run.json"), rec);
    console.log(`${path.basename(dir)}: ${check.status}${rec.check.failed.length ? ` (failed: ${rec.check.failed.join(", ")})` : ""}`);
  }
}

function readProbes(dir: string): Array<{ at: string; ok: boolean; latencyMs: number }> {
  const f = path.join(dir, "health.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; ok: boolean; latencyMs: number });
}

async function cmdScore(args: string[]): Promise<void> {
  for (const dir of runDirsFrom(args)) {
    const rec = readJson<RunRecord>(path.join(dir, "run.json"));
    if (rec.status !== "complete") {
      log(`${path.basename(dir)}: status ${rec.status}, not scored`);
      continue;
    }
    try {
      const s = await scoreRun(dir, { calibrate: values.calibrate === true });
      const fails = Object.entries(s.items).filter(([, i]) => i.final && !i.final.pass).map(([id]) => id);
      const unresolved = Object.entries(s.items).filter(([, i]) => !i.final).map(([id]) => id);
      console.log(`${path.basename(dir)}: ${Object.keys(s.items).length} items, jev ${s.jev.requests} req, model ${s.modelScorer.requests} req; failed: ${fails.join(", ") || "none"}${unresolved.length ? `; unresolved: ${unresolved.join(", ")}` : ""}`);
    } catch (err) {
      process.exitCode = 1;
      console.log(`${path.basename(dir)}: scoring failed: ${String(err)}`);
    }
  }
}

async function cmdSelftest(): Promise<void> {
  const root = path.join(SANDBOX_ROOT, randomHex(6));
  const scratch = fs.mkdtempSync(path.join(RESULTS_DIR, ".selftest-"));
  const ws = createWorkspace(root, scratch);
  try {
    const tc = await resolveToolchain();
    await writeProfile(ws, tc, ws.profile);
    const env = agentEnv(ws, linkToolchain(ws, tc), {});
    const checks = await isolationSelfTest(ws, tc, env);
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.expect.padEnd(7)}  ${c.name}${c.ok ? "" : `  ${c.detail}`}`);
    if (!checks.every((c) => c.ok)) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = positionals;
  switch (cmd) {
    case "run":
      return cmdRun();
    case "set":
      return cmdSet();
    case "check":
      return cmdCheck(rest);
    case "score":
      return cmdScore(rest);
    case "agreement": {
      const a = agreement(runDirsFrom(rest));
      console.log(JSON.stringify(a, null, 2));
      return;
    }
    case "budget": {
      for (const s of parseSets()) {
        const d = await gate(s.agent, s.tier, { estimatePct });
        printGate([`${d.set}: ${d.runs} runs (${runsInSet(s.tier)} per set), provider ${AGENTS[s.agent].provider}`, ...d.lines]);
      }
      return;
    }
    case "selftest":
      return cmdSelftest();
    default:
      console.error("usage: node harness/cli.ts <run|set|check|score|agreement|budget|selftest> [flags]; see eval/README.md");
      process.exit(2);
  }
}

await main();
