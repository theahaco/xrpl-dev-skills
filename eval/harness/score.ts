// Blind rubric scoring. Each run becomes an evidence packet that carries no
// arm, agent or run id: the task text, the final code, compiler output, error
// excerpts from the transcript and the xrpl changelog. Jev answers each rubric
// question first; answers under the confidence floor go to a blind model
// scorer (Claude Code with no tools). With --calibrate both score every item.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CACHE_DIR,
  JEV_CONFIDENCE_FLOOR,
  JEV_KEY_PATH,
  JEV_MAX_INPUT_TOKENS,
  JEV_MODEL,
  JEV_URL,
  MODEL_SCORER_ALIAS,
  RUBRIC_PATH,
  TASKS_DIR,
  type Tier,
} from "./config.ts";
import { claudeCredential, writeCredentialFiles } from "./credentials.ts";
import { toolOutputs } from "./infra.ts";
import type { RunRecord } from "./run.ts";
import type { TypecheckResult } from "./typecheck.ts";
import { exec, isProbablyText, log, readJson, readJsonIfExists, sha256, walkFiles, writeJson } from "./util.ts";

export type RubricItem = {
  id: string;
  tiers: Tier[];
  evidence: EvidenceKey[];
  instructions: string;
  criteria: Record<string, string>;
  pass: string[];
};
type Rubric = { version: number; items: RubricItem[] };
type EvidenceKey = "code" | "typecheck" | "errors" | "xrplVersion" | "xrplChangelog";

export const loadRubric = (): Rubric => readJson<Rubric>(RUBRIC_PATH);

// ~3 characters per token keeps code-heavy states safely under the limit.
const CHARS_PER_TOKEN = 3;

const CODE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const CONFIG_FILES = /(^|\/)(package\.json|tsconfig[^/]*\.json|\.env[^/]*)$/;

// Strips anything that would reveal the arm: installed-skill paths and
// mentions of skills.
export function blind(text: string): string {
  return text
    .replace(/\.(claude|agents|codex)\/skills\/[\w./-]*/g, "[path]")
    .replace(/SKILL\.md/g, "[file]")
    .replace(/\bxrpl-dev\b/g, "[name]")
    .replace(/\bskills?\b/gi, "[redacted]");
}

function codeEvidence(finalDir: string, budget: number): { text: string; truncated: boolean } {
  const files = walkFiles(finalDir, ["node_modules", ".git"]).filter((f) => CODE_EXT.test(f.rel) || CONFIG_FILES.test(f.rel));
  const parts = files
    .map((f) => ({ rel: f.rel, buf: fs.readFileSync(f.abs) }))
    .filter((f) => isProbablyText(f.buf))
    .map((f) => ({ rel: f.rel, text: f.buf.toString("utf8") }));
  let total = parts.reduce((s, p) => s + p.text.length + p.rel.length + 12, 0);
  let truncated = false;
  // Trim the largest file first until the whole thing fits.
  while (total > budget && parts.length) {
    const largest = parts.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const excess = total - budget;
    const keep = Math.max(2_000, largest.text.length - excess - 100);
    if (keep >= largest.text.length) break;
    total -= largest.text.length - keep;
    largest.text = `${largest.text.slice(0, keep)}\n/* [truncated by harness] */`;
    truncated = true;
  }
  return { text: blind(parts.map((p) => `=== ${p.rel} ===\n${p.text}`).join("\n\n")), truncated };
}

function typecheckEvidence(tc: TypecheckResult | undefined, budget: number): string {
  if (!tc) return "No compiler output was recorded.";
  if (tc.status === "not_typescript") return "The project contains no TypeScript source files.";
  const section = (label: string, r: TypecheckResult["strict"]): string =>
    r ? `[${label}: tsc -p ${r.config}] exit ${r.exitCode}, ${r.errorCount} errors (${r.errorsInProject} outside node_modules)\n${r.output.trim() || "(no output)"}` : `[${label}] not run (no tsconfig.json)`;
  const text = [`TypeScript ${tc.tscVersion ?? "?"} (${tc.tscSource === "project" ? "the project's own compiler" : "harness compiler"})`, section("project config", tc.project), section("strict forced on", tc.strict)].join("\n\n");
  return blind(text.slice(0, budget));
}

const ERROR_LINE = /\b(error|exception|failed|tec[A-Z_]+|tem[A-Z_]+|tef[A-Z_]+|ter[A-Z_]+|TS\d{4})\b/i;

function errorEvidence(transcriptFile: string, budget: number): string {
  const snippets: string[] = [];
  for (const out of toolOutputs(transcriptFile)) {
    if (!ERROR_LINE.test(out)) continue;
    const lines = out.split("\n").filter((l) => ERROR_LINE.test(l)).slice(0, 12);
    snippets.push(lines.join("\n").slice(0, 1_500));
  }
  if (!snippets.length) return "No error output was seen during the run.";
  let text = "";
  for (const [i, s] of snippets.entries()) {
    const next = `--- error ${i + 1} ---\n${s}\n`;
    if (text.length + next.length > budget) {
      text += `[${snippets.length - i} more error excerpts omitted]\n`;
      break;
    }
    text += next;
  }
  return blind(text);
}

async function changelogEvidence(version: string | undefined, budget: number): Promise<string> {
  if (!version) return "The xrpl package version could not be determined.";
  const file = path.join(CACHE_DIR, `xrpl-HISTORY-${version}.md`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://raw.githubusercontent.com/XRPLF/xrpl.js/xrpl%40${version}/packages/xrpl/HISTORY.md`);
    if (!res.ok) return `The changelog for xrpl ${version} could not be fetched (HTTP ${res.status}).`;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, await res.text());
  }
  const history = fs.readFileSync(file, "utf8");
  // Full sections from 4.0.0 onward, then only deprecation/removal lines.
  const cut = history.search(/^## 3\.\d+\.\d+/m);
  const recent = cut > 0 ? history.slice(0, cut) : history;
  const older = cut > 0 ? history.slice(cut).split("\n").filter((l) => /deprecat|remov|breaking/i.test(l)).join("\n") : "";
  return `${recent}\n## Deprecations and removals before 4.0.0\n${older}`.slice(0, budget);
}

export type Evidence = Record<EvidenceKey | "task", string> & { codeTruncated: boolean };

export async function buildEvidence(runDir: string, scale = 1): Promise<Evidence> {
  const run = readJson<RunRecord>(path.join(runDir, "run.json"));
  const budget = JEV_MAX_INPUT_TOKENS * CHARS_PER_TOKEN * scale;
  const code = codeEvidence(path.join(runDir, "final"), Math.floor(budget * 0.55));
  return {
    task: fs.readFileSync(path.join(TASKS_DIR, `${run.tier}.md`), "utf8"),
    code: code.text,
    codeTruncated: code.truncated,
    typecheck: typecheckEvidence(readJsonIfExists<TypecheckResult>(path.join(runDir, "typecheck.json")), Math.floor(budget * 0.25)),
    errors: errorEvidence(path.join(runDir, "transcript", "agent.jsonl"), Math.floor(budget * 0.3)),
    xrplVersion: run.xrpl?.installedVersion ?? "unknown",
    xrplChangelog: await changelogEvidence(run.xrpl?.installedVersion, Math.floor(budget * 0.35)),
  };
}

type JevAnswer = { type: string; choice: string; confidence: number; probabilities: Record<string, number> };
type JevResponse = { model?: string; answers?: Record<string, JevAnswer>; usage?: { input_tokens: number; output_tokens: number }; detail?: unknown };

function jevKey(): string {
  return fs.readFileSync(JEV_KEY_PATH, "utf8").trim();
}

async function askJev(state: Record<string, string>, items: RubricItem[]): Promise<{ status: number; body: JevResponse }> {
  const questions = Object.fromEntries(items.map((i) => [i.id, { type: "choice", instructions: i.instructions, criteria: i.criteria }]));
  const res = await fetch(JEV_URL, {
    method: "POST",
    // The key travels only in this header; it is never logged or written.
    headers: { "content-type": "application/json", authorization: `Bearer ${jevKey()}` },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: AbortSignal.timeout(180_000),
  });
  return { status: res.status, body: (await res.json()) as JevResponse };
}

type ModelAnswer = { choice: string; confidence: number; rationale: string };

const JUDGE_SYSTEM = [
  "You are a careful code reviewer scoring an XRP Ledger TypeScript project against a fixed rubric.",
  "You are given the task the developer asked for and evidence about the finished project in a JSON object called state.",
  "Answer every question by choosing exactly one of its options, using only the evidence given.",
  "Report your confidence in each choice as a number between 0 and 1, and give a one or two sentence rationale.",
].join(" ");

async function askModel(state: Record<string, string>, items: RubricItem[], opts: { minValidMs: number }): Promise<{ answers: Record<string, ModelAnswer>; model?: string; costUsd?: number }> {
  const schema = {
    type: "object",
    properties: {
      answers: {
        type: "object",
        properties: Object.fromEntries(
          items.map((i) => [
            i.id,
            {
              type: "object",
              properties: { choice: { type: "string", enum: Object.keys(i.criteria) }, confidence: { type: "number", minimum: 0, maximum: 1 }, rationale: { type: "string" } },
              required: ["choice", "confidence", "rationale"],
            },
          ]),
        ),
        required: items.map((i) => i.id),
      },
    },
    required: ["answers"],
  };
  const questions = items.map((i) => ({ id: i.id, question: i.instructions, options: i.criteria }));
  const prompt = `state = ${JSON.stringify(state, null, 1)}\n\nquestions = ${JSON.stringify(questions, null, 1)}\n\nAnswer every question.`;
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-judge-"));
  const cred = await claudeCredential(opts.minValidMs);
  writeCredentialFiles(cfg, cred);
  try {
    const env: NodeJS.ProcessEnv = {
      HOME: cfg,
      PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
      CLAUDE_CONFIG_DIR: cfg,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTOUPDATER: "1",
      LANG: "en_US.UTF-8",
    };
    const args = ["-p", "--model", MODEL_SCORER_ALIAS, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--system-prompt", JUDGE_SYSTEM, "--json-schema", JSON.stringify(schema)];
    const res = await exec("claude", args, { cwd: cfg, env, input: prompt, timeoutMs: 600_000 });
    const out = JSON.parse(res.stdout) as { structured_output?: { answers?: Record<string, ModelAnswer> }; result?: string; total_cost_usd?: number; modelUsage?: Record<string, unknown>; is_error?: boolean };
    const answers = out.structured_output?.answers ?? (JSON.parse(out.result ?? "{}") as { answers?: Record<string, ModelAnswer> }).answers;
    if (!answers) throw new Error(`model scorer returned no answers: ${res.stdout.slice(0, 500)}`);
    return { answers, model: Object.keys(out.modelUsage ?? {})[0], costUsd: out.total_cost_usd };
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

export type ItemScore = {
  final?: { choice: string; pass: boolean; source: "jev" | "model" };
  jev?: { choice: string; confidence: number; probabilities: Record<string, number> };
  model?: ModelAnswer;
};

export type ScoreRecord = {
  packetId: string;
  rubricVersion: number;
  scoredAt: string;
  calibrate: boolean;
  confidenceFloor: number;
  jev: { model?: string; requests: number; inputTokens: number; outputTokens: number; errors: string[] };
  modelScorer: { model?: string; requests: number; costUsd: number };
  evidence: { codeTruncated: boolean; chars: Record<string, number> };
  items: Record<string, ItemScore>;
};

function packetId(runDir: string): string {
  const saltFile = path.join(CACHE_DIR, "blind-salt");
  if (!fs.existsSync(saltFile)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(saltFile, sha256(`${Date.now()}-${Math.random()}`));
  }
  return sha256(`${fs.readFileSync(saltFile, "utf8")}:${path.basename(runDir)}`).slice(0, 16);
}

export async function scoreRun(runDir: string, opts: { calibrate: boolean }): Promise<ScoreRecord> {
  const run = readJson<RunRecord>(path.join(runDir, "run.json"));
  const rubric = loadRubric();
  const items = rubric.items.filter((i) => i.tiers.includes(run.tier));
  const record: ScoreRecord = {
    packetId: packetId(runDir),
    rubricVersion: rubric.version,
    scoredAt: new Date().toISOString(),
    calibrate: opts.calibrate,
    confidenceFloor: JEV_CONFIDENCE_FLOOR,
    jev: { requests: 0, inputTokens: 0, outputTokens: 0, errors: [] },
    modelScorer: { requests: 0, costUsd: 0 },
    evidence: { codeTruncated: false, chars: {} },
    items: Object.fromEntries(items.map((i) => [i.id, {}])),
  };
  // One Jev request per distinct evidence set.
  const groups = new Map<string, RubricItem[]>();
  for (const item of items) {
    const key = [...item.evidence].sort().join("+");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  let evidence = await buildEvidence(runDir);
  record.evidence = { codeTruncated: evidence.codeTruncated, chars: Object.fromEntries(Object.entries(evidence).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, (v as string).length])) };
  const stateFor = (ev: Evidence, group: RubricItem[]): Record<string, string> => {
    const keys = new Set<EvidenceKey>(group.flatMap((i) => i.evidence));
    return { task: ev.task, ...Object.fromEntries([...keys].map((k) => [k, ev[k]])) };
  };
  const modelQueue = new Map<string, RubricItem[]>();
  for (const [key, group] of groups) {
    let state = stateFor(evidence, group);
    let scale = 1;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { status, body } = await askJev(state, group);
      record.jev.requests++;
      if (status === 200 && body.answers) {
        record.jev.model = body.model;
        record.jev.inputTokens += body.usage?.input_tokens ?? 0;
        record.jev.outputTokens += body.usage?.output_tokens ?? 0;
        for (const item of group) {
          const a = body.answers[item.id];
          if (!a) continue;
          const score = record.items[item.id] ?? {};
          score.jev = { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
          if (a.confidence >= JEV_CONFIDENCE_FLOOR) score.final = { choice: a.choice, pass: item.pass.includes(a.choice), source: "jev" };
          record.items[item.id] = score;
        }
        break;
      }
      const detail = JSON.stringify(body.detail ?? body).slice(0, 200);
      record.jev.errors.push(`${key}: HTTP ${status} ${detail}`);
      if (!detail.includes("max_tokens_exceeded")) break;
      scale *= 0.7;
      evidence = await buildEvidence(runDir, scale);
      record.evidence.codeTruncated = true;
      state = stateFor(evidence, group);
    }
    const needModel = group.filter((i) => opts.calibrate || !record.items[i.id]?.final);
    if (needModel.length) modelQueue.set(key, needModel);
  }
  for (const [, group] of modelQueue) {
    const state = stateFor(await buildEvidence(runDir), group);
    log(`model scorer: ${group.map((i) => i.id).join(", ")}`);
    const res = await askModel(state, group, { minValidMs: 20 * 60_000 });
    record.modelScorer.requests++;
    record.modelScorer.model = res.model;
    record.modelScorer.costUsd += res.costUsd ?? 0;
    for (const item of group) {
      const a = res.answers[item.id];
      if (!a) continue;
      const score = record.items[item.id] ?? {};
      score.model = a;
      if (!score.final) score.final = { choice: a.choice, pass: item.pass.includes(a.choice), source: "model" };
      record.items[item.id] = score;
    }
  }
  writeJson(path.join(runDir, "score.json"), record);
  return record;
}

export type Agreement = { items: number; agree: number; rate: number; byItem: Record<string, { items: number; agree: number }>; aboveFloor: { items: number; agree: number } };

// Agreement between Jev and the model scorer on every item both scored.
export function agreement(runDirs: string[]): Agreement {
  const out: Agreement = { items: 0, agree: 0, rate: 0, byItem: {}, aboveFloor: { items: 0, agree: 0 } };
  for (const dir of runDirs) {
    const s = readJsonIfExists<ScoreRecord>(path.join(dir, "score.json"));
    if (!s) continue;
    for (const [id, item] of Object.entries(s.items)) {
      if (!item.jev || !item.model) continue;
      const same = item.jev.choice === item.model.choice;
      out.items++;
      if (same) out.agree++;
      const b = (out.byItem[id] ??= { items: 0, agree: 0 });
      b.items++;
      if (same) b.agree++;
      if (item.jev.confidence >= s.confidenceFloor) {
        out.aboveFloor.items++;
        if (same) out.aboveFloor.agree++;
      }
    }
  }
  out.rate = out.items ? out.agree / out.items : 0;
  return out;
}
