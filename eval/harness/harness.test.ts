import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { endsWithQuestion } from "./agents.ts";
import type { CheckResult } from "./check.ts";
import { classify, outageProbes } from "./infra.ts";
import { redactText, SEED_PLACEHOLDER } from "./redact.ts";
import { blind } from "./score.ts";
import { accountIdHex, issuanceId } from "./xrpl-rpc.ts";

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

function transcript(toolOutput: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-eval-test-"));
  const file = path.join(dir, "agent.jsonl");
  const ev = { type: "user", message: { content: [{ type: "tool_result", content: toolOutput }] } };
  fs.writeFileSync(file, `${JSON.stringify(ev)}\n`);
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

test("one failed probe is not an outage", () => {
  assert.equal(outageProbes([...healthy, { at: "a", ok: false, latencyMs: 1 }, ...healthy]), 0);
  assert.equal(outageProbes(outage), 2);
});
