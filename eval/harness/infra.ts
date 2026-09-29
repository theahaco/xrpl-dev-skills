// Decides whether a run's failure belongs to testnet infrastructure (re-run
// and flag) or to the agent (score it). A failure only counts as infra with
// independent evidence: the harness's own preflight, its own health monitor,
// or faucet errors (faucet limits must never count against an agent).
import fs from "node:fs";
import type { CheckResult } from "./check.ts";
import { healthProbe, type HealthProbe } from "./xrpl-rpc.ts";

export type InfraVerdict = {
  verdict: "ok" | "infra" | "check_retry";
  rerun: boolean;
  reasons: string[];
  // sandboxDenials: the agent hit the isolation boundary (usually writing to a
  // hardcoded /tmp path). Environment friction, reported, never infra.
  signals: { faucetErrors: string[]; rippledErrors: string[]; sandboxDenials: string[]; healthOutageProbes: number; healthProbes: number };
  suspect?: string;
};

export class HealthMonitor {
  private readonly file: string;
  private timer: NodeJS.Timeout | undefined;
  private readonly probes: HealthProbe[] = [];

  constructor(file: string) {
    this.file = file;
  }

  start(intervalMs = 30_000): void {
    const tick = async (): Promise<void> => {
      const p = await healthProbe();
      this.probes.push(p);
      fs.appendFileSync(this.file, `${JSON.stringify(p)}\n`);
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
  }

  stop(): HealthProbe[] {
    if (this.timer) clearInterval(this.timer);
    return this.probes;
  }
}

// Two consecutive failed probes (about a minute) count as an outage.
export function outageProbes(probes: HealthProbe[]): number {
  let worst = 0;
  let run = 0;
  for (const p of probes) {
    run = p.ok ? 0 : run + 1;
    worst = Math.max(worst, run);
  }
  return worst >= 2 ? probes.filter((p) => !p.ok).length : 0;
}

const FAUCET_HOST = /faucet\.(altnet|devnet)\.rippletest\.net|fundWallet/i;
const FAUCET_FAIL = /\b(429|502|503|504)\b|too many requests|rate.?limit|ETIMEDOUT|ECONNRESET|socket hang up|timed? ?out|RippledError|XRPLFaucetError|Request failed/i;
const SANDBOX_DENIED = /operation not permitted|\bEPERM\b/i;
const RIPPLED_FAIL = /DisconnectedError|NotConnectedError|ConnectionError|TimeoutError|websocket.*(closed|error)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|\b(tooBusy|noNetwork|noCurrent|slowDown|notSynced)\b|code:? 1006/i;

// Tool output text from a transcript (Claude stream-json or Codex --json).
export function toolOutputs(transcriptFile: string): string[] {
  if (!fs.existsSync(transcriptFile)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(transcriptFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "user") {
      const content = ((ev.message as { content?: unknown } | undefined)?.content ?? []) as unknown;
      if (!Array.isArray(content)) continue;
      for (const c of content as Array<{ type?: string; content?: unknown }>) {
        if (c.type !== "tool_result") continue;
        const text = Array.isArray(c.content) ? (c.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") : String(c.content ?? "");
        out.push(text);
      }
    } else if (ev.type === "item.completed") {
      const item = (ev.item ?? {}) as { type?: string; aggregated_output?: string; output?: string };
      if (item.type === "command_execution") out.push(String(item.aggregated_output ?? item.output ?? ""));
    }
  }
  return out;
}

function matches(outputs: string[], host: RegExp | undefined, fail: RegExp): string[] {
  const hits: string[] = [];
  for (const text of outputs) {
    if (host && !host.test(text)) continue;
    const m = fail.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 160);
    hits.push(text.slice(start, m.index + 160).replace(/\s+/g, " "));
  }
  return hits;
}

export function classify(input: { preflightError?: string; check?: CheckResult; transcriptFile: string; probes: HealthProbe[] }): InfraVerdict {
  const outputs = toolOutputs(input.transcriptFile);
  const faucetErrors = matches(outputs, FAUCET_HOST, FAUCET_FAIL).slice(0, 10);
  const rippledErrors = matches(outputs, undefined, RIPPLED_FAIL).slice(0, 10);
  const sandboxDenials = matches(outputs, undefined, SANDBOX_DENIED).slice(0, 10);
  const outage = outageProbes(input.probes);
  const signals = { faucetErrors, rippledErrors, sandboxDenials, healthOutageProbes: outage, healthProbes: input.probes.length };
  if (input.preflightError) return { verdict: "infra", rerun: true, reasons: [`preflight: ${input.preflightError}`], signals };
  const check = input.check;
  if (!check || check.status === "infra_error") {
    // The agent may well have succeeded; re-run the checker, not the agent.
    return { verdict: "check_retry", rerun: false, reasons: [`checker could not read testnet: ${check?.infraError ?? "no check result"}`], signals };
  }
  if (check.status === "pass") return { verdict: "ok", rerun: false, reasons: [], signals };
  const reasons: string[] = [];
  if (faucetErrors.length) reasons.push(`faucet errors in the agent's tool output (${faucetErrors.length})`);
  if (outage && rippledErrors.length) reasons.push(`testnet outage seen by the health monitor (${outage} failed probes) and connectivity errors in the agent's tool output`);
  if (reasons.length) return { verdict: "infra", rerun: true, reasons, signals };
  const verdict: InfraVerdict = { verdict: "ok", rerun: false, reasons: [], signals };
  if (rippledErrors.length) verdict.suspect = "connectivity errors in tool output while the health monitor saw testnet healthy; scored as an agent failure, review by hand";
  else if (outage) verdict.suspect = "health monitor saw an outage but the agent's output shows no connectivity errors; scored as an agent failure";
  return verdict;
}
