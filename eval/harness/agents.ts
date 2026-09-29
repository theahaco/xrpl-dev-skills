// Launches one agent non-interactively inside the sandbox, answers clarifying
// questions with the fixed reply, and collects usage from its event stream.
import fs from "node:fs";
import path from "node:path";
import { AGENTS, type AgentName, CLARIFY_REPLY, MAX_CLARIFY_REPLIES } from "./config.ts";
import { sandboxed, type Workspace } from "./sandbox.ts";
import { exec, log, nowIso } from "./util.ts";

export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd?: number;
};

export type Turn = {
  index: number;
  input: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  isError: boolean;
  finalText: string;
  askedQuestion: boolean;
  usage: Usage;
  numTurns?: number;
  terminalReason?: string;
};

export type AgentRun = {
  sessionId?: string;
  model?: string;
  effort?: string;
  cliVersion: string;
  turns: Turn[];
  clarifyReplies: number;
  timedOut: boolean;
  usage: Usage;
  tools?: string[];
  skillsVisible?: string[];
  mcpServers?: unknown[];
  sessionFiles: string[];
};

const emptyUsage = (): Usage => ({ inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 });

function addUsage(a: Usage, b: Usage): Usage {
  const cost = a.costUsd !== undefined || b.costUsd !== undefined ? (a.costUsd ?? 0) + (b.costUsd ?? 0) : undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

// A clarifying question: the agent stopped with a question and has not
// produced the deliverable yet. A trailing offer after finishing ("want me to
// add tests?") does not count.
export function endsWithQuestion(text: string): boolean {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  return /\?[*_)\s"'`]*$/.test(last);
}

export type LaunchOptions = {
  agent: AgentName;
  ws: Workspace;
  env: NodeJS.ProcessEnv;
  prompt: string;
  deadline: number;
  transcriptDir: string;
  deliverablePath: string;
};

export async function launchAgent(opts: LaunchOptions): Promise<AgentRun> {
  return AGENTS[opts.agent].provider === "claude" ? runClaude(opts) : runCodex(opts);
}

type TurnSpec = { cmd: string; args: string[]; input: string };

async function driveTurns(
  opts: LaunchOptions,
  firstTurn: TurnSpec,
  nextTurn: (sessionId: string) => TurnSpec,
  parse: (line: string, turn: Turn, run: AgentRun) => void,
  run: AgentRun,
): Promise<AgentRun> {
  const streamFile = path.join(opts.transcriptDir, "agent.jsonl");
  const stderrFile = path.join(opts.transcriptDir, "stderr.log");
  let spec = firstTurn;
  for (let i = 0; ; i++) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) {
      run.timedOut = true;
      break;
    }
    const turn: Turn = { index: i, input: spec.input, startedAt: nowIso(), endedAt: "", exitCode: null, timedOut: false, isError: false, finalText: "", askedQuestion: false, usage: emptyUsage() };
    fs.appendFileSync(streamFile, `${JSON.stringify({ type: "harness", event: "turn_start", turn: i, at: turn.startedAt, input: i === 0 ? "<prompt.md>" : spec.input })}\n`);
    const [cmd, args] = sandboxed(opts.ws, spec.cmd, spec.args);
    const res = await exec(cmd, args, {
      cwd: opts.ws.project,
      env: opts.env,
      input: spec.input,
      timeoutMs: remaining,
      stdoutFile: streamFile,
      stderrFile,
      onStdoutLine: (line) => {
        if (line.trim()) parse(line, turn, run);
      },
    });
    turn.endedAt = nowIso();
    turn.exitCode = res.code;
    turn.timedOut = res.timedOut;
    turn.askedQuestion = turn.askedQuestion || endsWithQuestion(turn.finalText);
    run.turns.push(turn);
    run.usage = addUsage(run.usage, turn.usage);
    fs.appendFileSync(streamFile, `${JSON.stringify({ type: "harness", event: "turn_end", turn: i, at: turn.endedAt, exitCode: res.code, timedOut: res.timedOut })}\n`);
    if (res.timedOut) {
      run.timedOut = true;
      break;
    }
    const delivered = fs.existsSync(opts.deliverablePath);
    if (!turn.askedQuestion || delivered || !run.sessionId || run.clarifyReplies >= MAX_CLARIFY_REPLIES) break;
    run.clarifyReplies++;
    log(`agent asked a question; replying "${CLARIFY_REPLY}" (${run.clarifyReplies}/${MAX_CLARIFY_REPLIES})`);
    spec = nextTurn(run.sessionId);
  }
  return run;
}

// --- Claude Code ------------------------------------------------------------

async function runClaude(opts: LaunchOptions): Promise<AgentRun> {
  const spec = AGENTS[opts.agent];
  const version = (await exec("claude", ["--version"], { env: opts.env })).stdout.trim();
  const base = ["-p", "--dangerously-skip-permissions", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"];
  if ("modelAlias" in spec) base.push("--model", spec.modelAlias);
  const run: AgentRun = { cliVersion: version, turns: [], clarifyReplies: 0, timedOut: false, usage: emptyUsage(), sessionFiles: [] };
  await driveTurns(
    opts,
    { cmd: "claude", args: base, input: opts.prompt },
    (sid) => ({ cmd: "claude", args: [...base, "--resume", sid], input: CLARIFY_REPLY }),
    (line, turn, r) => parseClaudeLine(line, turn, r),
    run,
  );
  const projects = path.join(opts.ws.config, "projects");
  if (fs.existsSync(projects)) {
    for (const dir of fs.readdirSync(projects)) {
      for (const f of fs.readdirSync(path.join(projects, dir))) if (f.endsWith(".jsonl")) run.sessionFiles.push(path.join(projects, dir, f));
    }
  }
  return run;
}

function parseClaudeLine(line: string, turn: Turn, run: AgentRun): void {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (ev.type === "system" && ev.subtype === "init") {
    run.sessionId = String(ev.session_id ?? run.sessionId ?? "");
    run.model = String(ev.model ?? run.model ?? "");
    run.tools = ev.tools as string[] | undefined;
    run.skillsVisible = ev.skills as string[] | undefined;
    run.mcpServers = ev.mcp_servers as unknown[] | undefined;
  } else if (ev.type === "assistant") {
    const content = ((ev.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<{ type?: string; name?: string }>;
    if (content.some((c) => c.type === "tool_use" && c.name === "AskUserQuestion")) turn.askedQuestion = true;
  } else if (ev.type === "result") {
    turn.finalText = String(ev.result ?? "");
    turn.isError = ev.is_error === true;
    turn.numTurns = Number(ev.num_turns ?? 0);
    turn.terminalReason = String(ev.terminal_reason ?? ev.subtype ?? "");
    const u = (ev.usage ?? {}) as Record<string, unknown>;
    const details = (u.output_tokens_details ?? {}) as Record<string, unknown>;
    turn.usage = {
      inputTokens: Number(u.input_tokens ?? 0),
      cachedInputTokens: Number(u.cache_read_input_tokens ?? 0),
      cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
      outputTokens: Number(u.output_tokens ?? 0),
      reasoningTokens: Number(details.thinking_tokens ?? 0),
      costUsd: Number(ev.total_cost_usd ?? 0),
    };
    const models = Object.keys((ev.modelUsage ?? {}) as object);
    if (models.length && !run.model) run.model = models[0];
  }
}

// --- Codex ------------------------------------------------------------------

async function runCodex(opts: LaunchOptions): Promise<AgentRun> {
  const version = (await exec("codex", ["--version"], { env: opts.env })).stdout.trim();
  // Codex's own Seatbelt sandbox cannot nest inside ours, so it is bypassed;
  // the outer sandbox is the isolation boundary. `apps` (account connectors)
  // is disabled for parity with Claude, where claude.ai connectors are off.
  const common = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--disable", "apps"];
  const run: AgentRun = { cliVersion: version, turns: [], clarifyReplies: 0, timedOut: false, usage: emptyUsage(), sessionFiles: [] };
  await driveTurns(
    opts,
    { cmd: "codex", args: ["exec", ...common, "-C", opts.ws.project, "-"], input: opts.prompt },
    (sid) => ({ cmd: "codex", args: ["exec", "resume", ...common, sid, "-"], input: CLARIFY_REPLY }),
    (line, turn, r) => parseCodexLine(line, turn, r),
    run,
  );
  const sessions = path.join(opts.ws.config, "sessions");
  if (fs.existsSync(sessions)) {
    for (const f of fs.readdirSync(sessions, { recursive: true, encoding: "utf8" })) if (f.endsWith(".jsonl")) run.sessionFiles.push(path.join(sessions, f));
  }
  for (const f of run.sessionFiles) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.includes('"turn_context"')) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; payload?: { model?: string; effort?: string | null; reasoning_effort?: string | null } };
        if (ev.type === "turn_context") {
          run.model = ev.payload?.model ?? run.model;
          run.effort = ev.payload?.effort ?? ev.payload?.reasoning_effort ?? run.effort ?? "default (unset in config)";
        }
      } catch {
        // Partial line.
      }
    }
  }
  return run;
}

function parseCodexLine(line: string, turn: Turn, run: AgentRun): void {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (ev.type === "thread.started") {
    run.sessionId = String(ev.thread_id ?? "");
  } else if (ev.type === "item.completed") {
    const item = (ev.item ?? {}) as { type?: string; text?: string };
    if (item.type === "agent_message" && item.text) turn.finalText = item.text;
  } else if (ev.type === "turn.completed") {
    const u = (ev.usage ?? {}) as Record<string, unknown>;
    turn.usage = addUsage(turn.usage, {
      inputTokens: Number(u.input_tokens ?? 0) - Number(u.cached_input_tokens ?? 0),
      cachedInputTokens: Number(u.cached_input_tokens ?? 0),
      cacheCreationTokens: 0,
      outputTokens: Number(u.output_tokens ?? 0),
      reasoningTokens: Number(u.reasoning_output_tokens ?? 0),
    });
  } else if (ev.type === "turn.failed" || ev.type === "error") {
    turn.isError = true;
    const err = (ev.error ?? {}) as { message?: string };
    turn.terminalReason = String(err.message ?? ev.message ?? ev.type);
  }
}
