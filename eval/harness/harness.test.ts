import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { endsWithQuestion } from "./agents.ts";
import type { CheckResult } from "./check.ts";
import { classify, outageProbes } from "./infra.ts";
import { redactText, SEED_PLACEHOLDER } from "./redact.ts";
import { blind, errorEvidence } from "./score.ts";
import { accountIdHex, issuanceId } from "./xrpl-rpc.ts";

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
