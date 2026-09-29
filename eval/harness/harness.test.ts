import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { endsWithQuestion } from "./agents.ts";
import { withBudgetLock, reserve } from "./budget.ts";
import { type CheckResult, type Ctx, deliveredTo } from "./check.ts";
import { classify, outageProbes } from "./infra.ts";
import { redactedJson, redactText, SEED_PLACEHOLDER } from "./redact.ts";
import { blind, buildEvidence, codeEvidence, errorEvidence, type RubricItem, scoreRun } from "./score.ts";
import { parseJsonc, strictFamily, typecheck } from "./typecheck.ts";
import { exec } from "./util.ts";
import { accountIdHex, issuanceId, type MptIssuance, type TxRecord } from "./xrpl-rpc.ts";

const buildErrors = (file: string): string => errorEvidence(file, 10_000);

test("endsWithQuestion spots a trailing question, not one mid-message", () => {
  assert.equal(endsWithQuestion("Which network should I use?"), true);
  assert.equal(endsWithQuestion("Done.\n\nShould I also add tests?**"), true);
  assert.equal(endsWithQuestion("Is it testnet? Yes, so I used testnet.\nAll done."), false);
  assert.equal(endsWithQuestion(""), false);
});

test("redactText removes known secrets and anything seed- or key-shaped", () => {
  const seed = "sEdTM1uX8pu2do5XvTnutH6HsouMaM2";
  const out = redactText(`seed=${seed} other=sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r key=ED${"A1".repeat(32)} tok=abcdefghijkl`, [
    { value: seed, kind: "seed" },
    { value: "abcdefghijkl", kind: "token" },
  ]);
  assert.ok(!out.includes(seed));
  assert.ok(!out.includes("sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r"));
  assert.ok(!out.includes("A1A1A1"));
  assert.ok(!out.includes("abcdefghijkl"));
  assert.ok(out.includes(SEED_PLACEHOLDER));
});

test("blind strips skill tells", () => {
  const out = blind("see .claude/skills/xrpl-dev/tokens.md and the xrpl-dev skill's SKILL.md");
  assert.ok(!/skill/i.test(out));
  assert.ok(!out.includes("xrpl-dev"));
});

test("issuance ids are sequence plus account id", () => {
  assert.equal(accountIdHex("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"), "B5F762798A53D543A014CAF8B297CFF8F2F937E8");
  assert.equal(issuanceId(1, "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"), "00000001B5F762798A53D543A014CAF8B297CFF8F2F937E8");
});

// A transcript with one tool call and its result, Claude stream-json style.
function transcript(toolOutput: string, tool = "Bash", command = "npm start"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-test-"));
  const file = path.join(dir, "agent.jsonl");
  const call = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: tool, input: { command } }] } };
  const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: toolOutput }] } };
  fs.writeFileSync(file, `${JSON.stringify(call)}\n${JSON.stringify(result)}\n`);
  return file;
}

const failed: CheckResult = { tier: "medium", issuer: "r", checkedAt: "", status: "fail", criteria: [{ id: "x", pass: false, detail: "" }], observed: {} };
const passed: CheckResult = { ...failed, status: "pass", criteria: [] };
const healthy = Array.from({ length: 4 }, (_, i) => ({ at: `${i}`, ok: true, latencyMs: 1 }));
const outage = [...healthy, { at: "a", ok: false, latencyMs: 1 }, { at: "b", ok: false, latencyMs: 1 }];

test("infra classifier needs independent evidence", () => {
  assert.equal(classify({ preflightError: "faucet HTTP 503", transcriptFile: "", probes: [] }).verdict, "infra");
  assert.equal(classify({ check: { ...failed, status: "infra_error", infraError: "x" }, transcriptFile: "", probes: [] }).verdict, "check_retry");
  const faucet = transcript("POST https://faucet.altnet.rippletest.net/accounts failed: 429 Too Many Requests");
  assert.equal(classify({ check: failed, transcriptFile: faucet, probes: healthy }).verdict, "infra");
  assert.equal(classify({ check: passed, transcriptFile: faucet, probes: outage }).verdict, "ok");
  const conn = transcript("DisconnectedError: websocket was closed");
  assert.equal(classify({ check: failed, transcriptFile: conn, probes: outage }).verdict, "infra");
  const agentBug = classify({ check: failed, transcriptFile: conn, probes: healthy });
  assert.equal(agentBug.verdict, "ok");
  assert.ok(agentBug.suspect);
  const denied = classify({ check: failed, transcriptFile: transcript("zsh: operation not permitted: /tmp/x.log"), probes: healthy });
  assert.equal(denied.verdict, "ok");
  assert.equal(denied.signals.sandboxDenials.length, 1);
});

test("infra classifier ignores file reads and needs the faucet error near the faucet", () => {
  const source = "await client.fundWallet(holder)\n" + "x".repeat(1_000) + "\nconst timeout = 30_000; // 503 handling";
  assert.equal(classify({ check: failed, transcriptFile: transcript(source, "Read"), probes: healthy }).verdict, "ok");
  assert.equal(classify({ check: failed, transcriptFile: transcript(source), probes: healthy }).verdict, "ok");
  const limit = classify({ check: failed, transcriptFile: transcript("done"), probes: healthy, agentErrors: ["error_during_execution Claude AI usage limit reached"] });
  assert.equal(limit.verdict, "infra");
  assert.equal(limit.signals.providerErrors.length, 1);
});

test("redaction holds after JSON escapes", () => {
  const json = JSON.stringify({ content: "seed:\nsEdTM1uX8pu2do5XvTnutH6HsouMaM2" });
  assert.ok(!redactText(json, []).includes("sEdTM1u"));
});

test("error evidence skips reference reads and non-code words", () => {
  const skillRead = buildErrors(transcript("Implement retry logic for terQUEUED and tefPAST_SEQ", "Bash", "cat .claude/skills/xrpl-dev/SKILL.md"));
  assert.equal(skillRead, "No error output was seen during the run.");
  const words = buildErrors(transcript("using a template in the terminal for technical reasons"));
  assert.equal(words, "No error output was seen during the run.");
  assert.match(buildErrors(transcript("Transaction failed: tecNO_AUTH")), /tecNO_AUTH/);
});

test("one failed probe is not an outage", () => {
  assert.equal(outageProbes([...healthy, { at: "a", ok: false, latencyMs: 1 }, ...healthy]), 0);
  assert.equal(outageProbes(outage), 2);
});

// --- Review fixes -------------------------------------------------------------

test("only the issuer's own payments count toward the holder's 1,000", () => {
  const id = "00000001B5F762798A53D543A014CAF8B297CFF8F2F937E8";
  const pay = (account: string, value: string): TxRecord => ({
    hash: value,
    ledgerIndex: 1,
    txIndex: 0,
    validated: true,
    result: "tesSUCCESS",
    tx: { TransactionType: "Payment", Account: account, Destination: "rHolder", DeliverMax: { mpt_issuance_id: id, value } },
    meta: { delivered_amount: { mpt_issuance_id: id, value } },
  });
  const issuance: MptIssuance = { id, issuer: "rIssuer", flags: 0, outstanding: 1000n, assetScale: 0, raw: {} };
  const ctx: Ctx = { issuer: "rIssuer", txs: [pay("rIssuer", "1"), pay("rOtherHolder", "999")], issuance, scale: 1n };
  assert.equal(deliveredTo(ctx, "rHolder"), 1n);
});

test("lowercase secp256k1 private keys are redacted", () => {
  const key = `00${"ab".repeat(32)}`;
  assert.ok(!redactText(`key=${key}`, []).includes(key));
  assert.ok(!redactText(`key=${key.toUpperCase()}`, []).includes(key.toUpperCase()));
});

test("redactedJson scrubs pattern-only secrets from an in-memory record", () => {
  const record = { turns: [{ errorText: "holder seed sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r and key ED" + "cd".repeat(32) }] };
  const out = redactedJson(record, []);
  assert.ok(!out.includes("sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r"));
  assert.ok(!out.includes("cdcdcd"));
  assert.doesNotThrow(() => JSON.parse(out));
});

test("code evidence truncation terminates when files sit just above the floor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-code-"));
  fs.mkdirSync(path.join(dir, "src"));
  // Two files just over the 2,000-char floor and a budget neither fits in:
  // the old loop re-added the marker and picked the same file forever.
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "a".repeat(2_050));
  fs.writeFileSync(path.join(dir, "src", "b.ts"), "b".repeat(2_050));
  const res = codeEvidence(dir, 3_000);
  assert.equal(res.truncated, true);
  assert.ok(res.text.length < 4_200);
  assert.match(res.text, /omitted by harness to fit: src\/b\.ts/);
});

test("reservations get one file each and the budget lock serializes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-res-"));
  const r = { set: "claude-opus:complex", claudePct: 1, codexPct: 0, pid: process.pid, at: "" };
  const releaseA = reserve(r, dir);
  reserve(r, dir);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length, 2);
  releaseA();
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1);

  let inside = 0;
  let maxInside = 0;
  const critical = async (): Promise<void> => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((res) => setTimeout(res, 50));
    inside--;
  };
  await Promise.all([withBudgetLock(critical, dir), withBudgetLock(critical, dir), withBudgetLock(critical, dir)]);
  assert.equal(maxInside, 1);

  // A lock left by a process that no longer exists is taken over.
  fs.mkdirSync(path.join(dir, ".lock"));
  fs.writeFileSync(path.join(dir, ".lock", "owner"), "999999");
  assert.equal(await withBudgetLock(async () => "ran", dir, 2_000), "ran");
});

test("a shrink for one rubric group does not carry over to the next", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-score-"));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ tier: "medium", xrpl: {} }));
  fs.mkdirSync(path.join(runDir, "final", "src"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "final", "src", "index.ts"), `${"const x = 1;\n".repeat(3_000)}`);
  const full = (await buildEvidence(runDir)).code.length;
  const codeLengths: number[] = [];
  let calls = 0;
  const askJev = async (state: Record<string, string>, items: RubricItem[]) => {
    calls++;
    if (state.code !== undefined) codeLengths.push(state.code.length);
    if (calls === 1) return { status: 400, body: { detail: { error_type: "max_tokens_exceeded" } } };
    const answers = Object.fromEntries(items.map((i) => [i.id, { type: "choice", choice: Object.keys(i.criteria)[0] ?? "", confidence: 0.99, probabilities: {} }]));
    return { status: 200, body: { answers } };
  };
  const askModel = async () => {
    throw new Error("not expected");
  };
  const rec = await scoreRun(runDir, { calibrate: false }, { askJev, askModel });
  assert.ok((codeLengths[1] ?? full) < full, "the retry shrinks");
  assert.deepEqual(codeLengths.slice(2), codeLengths.slice(2).map(() => full), "later groups get the full code");
  assert.equal(rec.evidence.shrunkForGroups?.length, 1);
});

test("strict run overrides explicit strict-family opt-outs and records them", async () => {
  assert.ok(strictFamily("Version 5.9.3").includes("strictBuiltinIteratorReturn"));
  assert.ok(!strictFamily("Version 5.4.5").includes("strictBuiltinIteratorReturn"));
  assert.deepEqual(parseJsonc('{ // c\n "a": [1, 2,], /* x */ "b": "//not a comment", }'), { a: [1, 2], b: "//not a comment" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-tsc-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), '{\n  // opted out\n  "compilerOptions": { "strict": true, "strictNullChecks": false, "noImplicitAny": false, "noEmit": true, "types": [] },\n  "include": ["src/**/*.ts"],\n}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "const x: string = null;\nexport function f(a) { return a; }\nexport { x };\n");
  const res = await typecheck(dir, (args) => exec(process.execPath, args, { cwd: dir, timeoutMs: 120_000 }));
  assert.equal(res.project?.errorsInProject, 0);
  assert.ok((res.strict?.errorsInProject ?? 0) >= 2, res.strict?.output);
  assert.deepEqual(res.projectStrictness?.optOuts.sort(), ["noImplicitAny: false", "strictNullChecks: false"]);
});
