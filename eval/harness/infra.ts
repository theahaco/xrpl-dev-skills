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
  signals: { faucetErrors: string[]; rippledErrors: string[]; sandboxDenials: string[]; providerErrors: string[]; healthOutageProbes: number; healthProbes: number };
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

const FAUCET_HOST = /faucet\.(altnet|devnet)\.rippletest\.net|fundWallet/gi;
const FAUCET_FAIL = /\b(429|502|503|504)\b|too many requests|rate.?limit|ETIMEDOUT|ECONNRESET|socket hang up|timed out|XRPLFaucetError|Request failed/i;
const SANDBOX_DENIED = /operation not permitted|\bEPERM\b/i;
const RIPPLED_FAIL = /DisconnectedError|NotConnectedError|ConnectionError|TimeoutError|websocket.*(closed|error)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|\b(tooBusy|noNetwork|noCurrent|slowDown|notSynced)\b|code:? 1006/i;
// Provider-side limits, as reported by the agent CLI itself.
const PROVIDER_LIMIT = /usage limit|rate[ _-]?limit|\b429\b|overloaded|\b529\b|quota exceeded|insufficient_quota|hit your limit|limit reached/i;

export type CommandOutput = { command: string; output: string };

// Output of the shell commands the agent ran (Claude's Bash tool, Codex's
// command_execution), not file reads, edits or web fetches: those show the
// agent's own source and the docs it read, which would trip the error
// patterns and (for scoring) reveal the arm.
export function commandOutputs(transcriptFile: string): CommandOutput[] {
  if (!transcriptFile || !fs.existsSync(transcriptFile)) return [];
  const out: CommandOutput[] = [];
  const bashCalls = new Map<string, string>();
  for (const line of fs.readFileSync(transcriptFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (ev.type === "assistant" && Array.isArray(content)) {
      for (const c of content as Array<{ type?: string; id?: string; name?: string; input?: { command?: string } }>) {
        if (c.type === "tool_use" && c.name === "Bash" && c.id) bashCalls.set(c.id, String(c.input?.command ?? ""));
      }
    } else if (ev.type === "user" && Array.isArray(content)) {
      for (const c of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (c.type !== "tool_result" || !c.tool_use_id || !bashCalls.has(c.tool_use_id)) continue;
        const text = Array.isArray(c.content) ? (c.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") : String(c.content ?? "");
        out.push({ command: bashCalls.get(c.tool_use_id) ?? "", output: text });
      }
    } else if (ev.type === "item.completed") {
      const item = (ev.item ?? {}) as { type?: string; command?: string; aggregated_output?: string; output?: string };
      if (item.type === "command_execution") out.push({ command: String(item.command ?? ""), output: String(item.aggregated_output ?? item.output ?? "") });
    }
  }
  return out;
}

const snippet = (text: string, index: number): string => text.slice(Math.max(0, index - 160), index + 160).replace(/\s+/g, " ");

function matches(outputs: CommandOutput[], fail: RegExp): string[] {
  const hits: string[] = [];
  for (const { output } of outputs) {
    const m = fail.exec(output);
    if (m) hits.push(snippet(output, m.index));
  }
  return hits;
}

// A faucet failure needs the failure text within 300 characters of a faucet
// reference, not merely somewhere in the same output.
function faucetMatches(outputs: CommandOutput[]): string[] {
  const hits: string[] = [];
  for (const { output } of outputs) {
    for (const m of output.matchAll(FAUCET_HOST)) {
      const window = output.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300);
      if (FAUCET_FAIL.test(window)) {
        hits.push(snippet(output, m.index));
        break;
      }
    }
  }
  return hits;
}

export function classify(input: { preflightError?: string; check?: CheckResult; transcriptFile: string; probes: HealthProbe[]; agentErrors?: string[] }): InfraVerdict {
  const outputs = commandOutputs(input.transcriptFile);
  const faucetErrors = faucetMatches(outputs).slice(0, 10);
  const rippledErrors = matches(outputs, RIPPLED_FAIL).slice(0, 10);
  const sandboxDenials = matches(outputs, SANDBOX_DENIED).slice(0, 10);
  const providerErrors = (input.agentErrors ?? []).filter((t) => PROVIDER_LIMIT.test(t)).map((t) => t.replace(/\s+/g, " ").slice(0, 300));
  const outage = outageProbes(input.probes);
  const signals = { faucetErrors, rippledErrors, sandboxDenials, providerErrors, healthOutageProbes: outage, healthProbes: input.probes.length };
  if (input.preflightError) return { verdict: "infra", rerun: true, reasons: [`preflight: ${input.preflightError}`], signals };
  const check = input.check;
  if (!check || check.status === "infra_error") {
    // The agent may well have succeeded; re-run the checker, not the agent.
    return { verdict: "check_retry", rerun: false, reasons: [`checker could not read testnet: ${check?.infraError ?? "no check result"}`], signals };
  }
  if (check.status === "pass") return { verdict: "ok", rerun: false, reasons: [], signals };
  const reasons: string[] = [];
  if (providerErrors.length) reasons.push(`the agent CLI hit a provider usage or rate limit (${providerErrors.length})`);
  if (faucetErrors.length) reasons.push(`faucet errors in the agent's command output (${faucetErrors.length})`);
  if (outage && rippledErrors.length) reasons.push(`testnet outage seen by the health monitor (${outage} failed probes) and connectivity errors in the agent's command output`);
  if (reasons.length) return { verdict: "infra", rerun: true, reasons, signals };
  const verdict: InfraVerdict = { verdict: "ok", rerun: false, reasons: [], signals };
  if (rippledErrors.length) verdict.suspect = "connectivity errors in command output while the health monitor saw testnet healthy; scored as an agent failure, review by hand";
  else if (outage) verdict.suspect = "health monitor saw an outage but the agent's output shows no connectivity errors; scored as an agent failure";
  return verdict;
}
