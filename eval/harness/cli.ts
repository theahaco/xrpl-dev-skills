// Entry point: `node harness/cli.ts <command> [flags]`. See eval/README.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type GateDecision, gate, type Reservation, reserve, runsInSet, withBudgetLock } from "./budget.ts";
import { checkRun } from "./check.ts";
import {
  AGENT_NAMES,
  AGENTS,
  type AgentName,
  ARMS,
  DEFAULT_CONCURRENCY,
  EVAL_DIR,
  MAX_INFRA_RERUNS,
  REPS,
  RESULTS_DIR,
  SANDBOX_ROOT,
  type Tier,
  TIERS,
} from "./config.ts";
import { classify } from "./infra.ts";
import { agentErrorTexts, type RunRecord, type RunSpec, runId, runOne } from "./run.ts";
import { agentEnv, createWorkspace, isolationSelfTest, linkToolchain, resolveToolchain, sandboxed, writeProfile } from "./sandbox.ts";
import { redactedJson } from "./redact.ts";
import { agreement, scoreRun } from "./score.ts";
import { typecheck } from "./typecheck.ts";
import { copyFiles, exec, log, randomHex, readJson, readJsonIfExists, walkFiles, writeJson } from "./util.ts";

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

function reservationFor(d: GateDecision): Reservation {
  return { set: d.set, claudePct: d.cost.claudePct, codexPct: d.cost.codexPct, pid: process.pid, at: new Date().toISOString() };
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
  let release = (): void => {};
  if (!values["no-gate"]) {
    const decision = await withBudgetLock(async () => {
      const d = await gate(spec.agent, spec.tier, { runs: 1, estimatePct });
      if (d.allowed) release = reserve(reservationFor(d));
      return d;
    });
    printGate(decision.lines);
    if (!decision.allowed) process.exit(3);
  }
  let rec: RunRecord;
  try {
    rec = await runWithReruns(spec, values["keep-workspace"] === true);
  } finally {
    release();
  }
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
  // Gate and reserve under one lock, so two concurrent `set` processes cannot
  // both pass against the same remaining allowance.
  const allowed = await withBudgetLock(async () => {
    for (const s of sets) {
      const decision = await gate(s.agent, s.tier, { estimatePct });
      printGate(decision.lines);
      if (!decision.allowed) {
        for (const r of releases) r();
        return false;
      }
      // Later sets in the same invocation see this one's reservation.
      releases.push(reserve(reservationFor(decision)));
    }
    return true;
  });
  if (!allowed) process.exit(3);
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
    fs.writeFileSync(path.join(dir, "infra.json"), redactedJson(rec.infra, []));
    fs.writeFileSync(path.join(dir, "run.json"), redactedJson(rec, []));
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

// Re-runs the typecheck for finished runs: reinstalls dependencies from the
// committed final/ lockfile inside the sandbox, then checks as a run would.
async function cmdTypecheck(args: string[]): Promise<void> {
  for (const dir of runDirsFrom(args)) {
    const final = path.join(dir, "final");
    const root = path.join(SANDBOX_ROOT, randomHex(6));
    const profiles = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-tc-"));
    const ws = createWorkspace(root, profiles);
    try {
      const tc = await resolveToolchain();
      await writeProfile(ws, tc, ws.profile);
      await writeProfile(ws, tc, ws.postProfile, [path.join(EVAL_DIR, "node_modules")]);
      const env = agentEnv(ws, linkToolchain(ws, tc), {});
      copyFiles(walkFiles(final, []), final, ws.project);
      const lock = fs.existsSync(path.join(ws.project, "package-lock.json"));
      const [cmd, argv] = sandboxed(ws, "npm", [lock ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"]);
      const inst = await exec(cmd, argv, { cwd: ws.project, env, timeoutMs: 600_000 });
      if (inst.code !== 0) throw new Error(`dependency install failed: ${(inst.stderr || inst.stdout).trim().slice(-300)}`);
      const result = await typecheck(ws.project, (a) => {
        const [c, v] = sandboxed(ws, tc.nodeBin, a, ws.postProfile);
        return exec(c, v, { cwd: ws.project, env, timeoutMs: 300_000 });
      });
      result.rebuilt = { from: lock ? "final/package-lock.json" : "final/package.json", at: new Date().toISOString() };
      writeJson(path.join(dir, "typecheck.json"), result);
      const ps = result.projectStrictness;
      console.log(`${path.basename(dir)}: tsc ${result.tscVersion ?? "-"}; project ${result.project?.errorsInProject ?? "-"} errors, strict ${result.strict?.errorsInProject ?? "-"} errors; opt-outs: ${ps?.optOuts.join(", ") || "none"}`);
    } catch (err) {
      process.exitCode = 1;
      console.log(`${path.basename(dir)}: typecheck failed: ${String(err)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(profiles, { recursive: true, force: true });
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
    case "typecheck":
      return cmdTypecheck(rest);
    case "selftest":
      return cmdSelftest();
    default:
      console.error("usage: node harness/cli.ts <run|set|check|typecheck|score|agreement|budget|selftest> [flags]; see eval/README.md");
      process.exit(2);
  }
}

await main();
