// One run: (agent, tier, arm, rep) -> a results directory.
import fs from "node:fs";
import path from "node:path";
import { launchAgent, type AgentRun } from "./agents.ts";
import { type CheckResult, checkRun } from "./check.ts";
import {
  AGENTS,
  type AgentName,
  type Arm,
  armHasResearch,
  armHasSkill,
  CACHE_DIR,
  EVAL_DIR,
  JEV_KEY_PATH,
  RESULTS_DIR,
  SANDBOX_ROOT,
  SKILL_INSTALL_DIR,
  TASKS_DIR,
  type Tier,
  TIME_CAP_MINUTES,
  UPSTREAM_SKILL_REF,
  UPSTREAM_SKILL_REPO,
} from "./config.ts";
import { type Credential, claudeCredential, codexCredential, removeCredentialFiles, writeCredentialFiles } from "./credentials.ts";
import { classify, HealthMonitor, type InfraVerdict } from "./infra.ts";
import { weeklyQuota, type QuotaReading } from "./budget.ts";
import { leakedSecrets, redactedJson, redactText, redactTree, type Secret } from "./redact.ts";
import { agentEnv, createWorkspace, isolationSelfTest, killStrays, linkToolchain, resolveToolchain, sandboxed, writeProfile, type IsolationCheck, type Workspace } from "./sandbox.ts";
import { typecheck } from "./typecheck.ts";
import { copyFiles, exec, execOk, hashTree, log, nowIso, randomHex, readJsonInside, realpathInside, sha256, walkFiles, writeJson } from "./util.ts";
import { fundAccount, type FundedAccount, InfraError, networkSnapshot, type NetworkSnapshot } from "./xrpl-rpc.ts";

export type RunSpec = { agent: AgentName; tier: Tier; arm: Arm; rep: number };

export type RunRecord = RunSpec & {
  runId: string;
  status: "complete" | "infra" | "error";
  attempt: number;
  rerunOf?: string;
  startedAt: string;
  endedAt: string;
  timeCapMinutes: number;
  wallClockSeconds?: number;
  agentSeconds?: number;
  host: { platform: string; osVersion: string; node: string; npm: string };
  agentInfo?: {
    cli: string;
    cliVersion: string;
    model?: string;
    effort?: string;
    modelMatchesExpected?: boolean;
    sessionId?: string;
    tools?: string[];
    skillsVisible?: string[];
    mcpServers?: unknown[];
  };
  skill?: { repo: string; ref: string; commit: string; installerSha256: string; installCommand: string; installDir: string; hashBefore: string; hashAfter?: string };
  account?: { address: string; fundedXrp: number };
  network?: NetworkSnapshot;
  isolation?: { mechanism: string; passed: boolean; checks: IsolationCheck[] };
  usage?: AgentRun["usage"];
  turns?: Array<Omit<AgentRun["turns"][number], "finalText" | "input"> & { finalTextChars: number; errorText?: string }>;
  clarifyReplies?: number;
  timedOut?: boolean;
  quota?: { before?: QuotaReading; after?: QuotaReading };
  xrpl?: { installedVersion?: string; dependencySpec?: string };
  check?: { status: CheckResult["status"]; failed: string[] };
  infra?: InfraVerdict;
  error?: string;
  redactedFiles?: number;
  strayProcessesKilled?: number;
  capture?: { files: number; skippedLarge: string[]; skippedUnsafe: string[]; renamedGitignores: string[] };
};

// Error text from the agent CLI itself (failed turns, stderr), which is where
// provider usage limits and overload errors show up.
export function agentErrorTexts(record: RunRecord, transcriptDir: string): string[] {
  const texts = (record.turns ?? []).flatMap((t) => (t.isError ? [`${t.terminalReason ?? ""} ${t.errorText ?? ""}`] : []));
  const stderr = path.join(transcriptDir, "stderr.log");
  if (fs.existsSync(stderr)) texts.push(fs.readFileSync(stderr, "utf8").slice(-20_000));
  return texts;
}

export const runId = (s: RunSpec): string => `${s.tier}__${s.agent}__${s.arm}__r${s.rep}`;

export function composePrompt(tier: Tier, arm: Arm, account: FundedAccount): string {
  const task = fs.readFileSync(path.join(TASKS_DIR, `${tier}.md`), "utf8").trim();
  const env = fs
    .readFileSync(path.join(TASKS_DIR, "environment.md"), "utf8")
    .replace("{{ADDRESS}}", account.address)
    .replace("{{SEED}}", account.seed)
    .replace("{{FUNDED_XRP}}", String(Math.floor(account.fundedXrp)))
    .trim();
  const parts = armHasResearch(arm) ? [fs.readFileSync(path.join(TASKS_DIR, "research-preamble.md"), "utf8").trim(), task, env] : [task, env];
  return `${parts.join("\n\n")}\n`;
}

// Clones upstream once per harness process, pinned to one commit for the set.
// The promise is cached so concurrent skill-arm runs share one clone.
let upstreamClone: Promise<{ dir: string; commit: string }> | undefined;
function upstreamSkill(): Promise<{ dir: string; commit: string }> {
  upstreamClone ??= (async () => {
    const dir = path.join(CACHE_DIR, "upstream-skill");
    fs.rmSync(dir, { recursive: true, force: true });
    await execOk("git", ["clone", "--quiet", "--depth", "1", "--branch", UPSTREAM_SKILL_REF, UPSTREAM_SKILL_REPO, dir]);
    const commit = (await execOk("git", ["-C", dir, "rev-parse", "HEAD"])).trim();
    return { dir, commit };
  })();
  upstreamClone.catch(() => {
    upstreamClone = undefined;
  });
  return upstreamClone;
}

export async function installSkill(spec: RunSpec, ws: Workspace, env: NodeJS.ProcessEnv): Promise<NonNullable<RunRecord["skill"]>> {
  const up = await upstreamSkill();
  const provider = AGENTS[spec.agent].provider;
  const installDir = SKILL_INSTALL_DIR[provider];
  // Upstream's own installer. Claude gets its documented --project form; for
  // Codex the installer has no matching option, so --path points it at the
  // directory Codex loads.
  const args = provider === "claude" ? ["--project"] : ["--path", installDir];
  // The installer is upstream code, so it gets the agent's boundary: an
  // exact copy of the pinned commit (git archive, not the working tree) runs
  // inside the sandbox, which only lets it write into the workspace.
  const src = path.join(ws.root, ".skill-installer");
  const tarball = path.join(ws.tmp, "skill-installer.tar");
  await execOk("git", ["-C", up.dir, "archive", "--format=tar", "-o", tarball, up.commit]);
  fs.mkdirSync(src);
  await execOk("/usr/bin/tar", ["-xf", tarball, "-C", src]);
  const installer = path.join(src, "install.sh");
  const installerSha256 = sha256(fs.readFileSync(installer));
  try {
    const [cmd, argv] = sandboxed(ws, "/bin/bash", [installer, ...args]);
    const res = await exec(cmd, argv, { cwd: ws.project, env, timeoutMs: 120_000 });
    if (res.code !== 0) throw new Error(`skill installer exited ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
  }
  return {
    repo: UPSTREAM_SKILL_REPO,
    ref: UPSTREAM_SKILL_REF,
    commit: up.commit,
    installerSha256,
    installCommand: `install.sh ${args.join(" ")}`,
    installDir,
    hashBefore: hashTree(path.join(ws.project, installDir)),
  };
}

async function hostInfo(): Promise<RunRecord["host"]> {
  const os = process.platform === "darwin" ? (await exec("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim() : "";
  return { platform: process.platform, osVersion: os, node: process.version, npm: (await exec("npm", ["--version"])).stdout.trim() };
}

async function quotaSafe(provider: "claude" | "codex"): Promise<QuotaReading | undefined> {
  try {
    return await weeklyQuota(provider);
  } catch (err) {
    log(`quota read failed: ${String(err)}`);
    return undefined;
  }
}

export type RunOptions = { keepWorkspace?: boolean; attempt?: number; rerunOf?: string; outDir?: string };

export async function runOne(spec: RunSpec, opts: RunOptions = {}): Promise<RunRecord> {
  const id = runId(spec);
  const outDir = opts.outDir ?? path.join(RESULTS_DIR, id);
  if (fs.existsSync(outDir)) throw new Error(`${outDir} already exists; move it aside to re-run`);
  const transcriptDir = path.join(outDir, "transcript");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const provider = AGENTS[spec.agent].provider;
  const capMs = TIME_CAP_MINUTES[spec.tier] * 60_000;
  const record: RunRecord = {
    ...spec,
    runId: id,
    status: "error",
    attempt: opts.attempt ?? 1,
    ...(opts.rerunOf ? { rerunOf: opts.rerunOf } : {}),
    startedAt: nowIso(),
    endedAt: "",
    timeCapMinutes: TIME_CAP_MINUTES[spec.tier],
    host: await hostInfo(),
  };
  const secrets: Secret[] = [];
  // Never given to a run; listed only so a leak would be caught and redacted.
  if (fs.existsSync(JEV_KEY_PATH)) secrets.push({ value: fs.readFileSync(JEV_KEY_PATH, "utf8").trim(), kind: "token" });
  const started = Date.now();
  const wsRoot = path.join(SANDBOX_ROOT, randomHex(6));
  const ws = createWorkspace(wsRoot, outDir);
  let cred: Credential | undefined;
  let monitor: HealthMonitor | undefined;
  try {
    cred = provider === "claude" ? await claudeCredential(capMs + 20 * 60_000) : await codexCredential(capMs + 20 * 60_000);
    for (const s of cred.secrets) secrets.push({ value: s, kind: "token" });
    const tc = await resolveToolchain();
    await writeProfile(ws, tc, ws.profile);
    await writeProfile(ws, tc, ws.postProfile, [path.join(EVAL_DIR, "node_modules")]);
    const pathVar = linkToolchain(ws, tc);
    const extra: Record<string, string> =
      provider === "claude"
        ? { CLAUDE_CONFIG_DIR: ws.config, ENABLE_CLAUDEAI_MCP_SERVERS: "false", DISABLE_AUTOUPDATER: "1" }
        : { CODEX_HOME: ws.config };
    const env = agentEnv(ws, pathVar, extra);
    await execOk("git", ["init", "--quiet", ws.project], { env });
    if (armHasSkill(spec.arm)) record.skill = await installSkill(spec, ws, env);

    const checks = await isolationSelfTest(ws, tc, env);
    fs.rmSync(path.join(ws.home, ".npm"), { recursive: true, force: true });
    record.isolation = { mechanism: "macOS sandbox-exec (Seatbelt) profile + scrubbed env + throwaway HOME/config dir", passed: checks.every((c) => c.ok), checks };
    writeJson(path.join(outDir, "isolation.json"), record.isolation);
    if (!record.isolation.passed) throw new Error(`isolation self-test failed: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);

    let account: FundedAccount;
    try {
      record.network = await networkSnapshot();
      account = await fundAccount();
    } catch (err) {
      if (!(err instanceof InfraError)) throw err;
      record.status = "infra";
      record.infra = classify({ preflightError: err.message, transcriptFile: "", probes: [] });
      writeJson(path.join(outDir, "infra.json"), record.infra);
      return record;
    }
    secrets.push({ value: account.seed, kind: "seed" });
    record.account = { address: account.address, fundedXrp: account.fundedXrp };
    const prompt = composePrompt(spec.tier, spec.arm, account);
    fs.writeFileSync(path.join(outDir, "prompt.md"), redactText(prompt, secrets));

    writeCredentialFiles(ws.config, cred);
    record.quota = { before: await quotaSafe(provider) };
    monitor = new HealthMonitor(path.join(outDir, "health.jsonl"));
    monitor.start();
    log(`${id}: launching ${spec.agent} in ${ws.project} (cap ${TIME_CAP_MINUTES[spec.tier]} min)`);
    const agentStarted = Date.now();
    const agentRun = await launchAgent({
      agent: spec.agent,
      ws,
      env,
      prompt,
      deadline: agentStarted + capMs,
      transcriptDir,
      deliverablePath: path.join(ws.project, "result.json"),
    });
    record.agentSeconds = Math.round((Date.now() - agentStarted) / 1000);
    const probes = monitor.stop();
    removeCredentialFiles(ws.config, cred);
    record.strayProcessesKilled = await killStrays(ws);
    // Everything below reads the workspace from outside the sandbox; refuse if
    // the agent swapped the project directory for a link elsewhere.
    if (!realpathInside(ws.root, ws.project) || !realpathInside(ws.root, ws.config)) throw new Error("project or config directory resolves outside the workspace");
    record.quota.after = await quotaSafe(provider);

    const expect = AGENTS[spec.agent];
    record.agentInfo = {
      cli: provider,
      cliVersion: agentRun.cliVersion,
      model: agentRun.model,
      effort: agentRun.effort,
      ...("expectModel" in expect && agentRun.model ? { modelMatchesExpected: expect.expectModel.test(agentRun.model) } : {}),
      sessionId: agentRun.sessionId,
      tools: agentRun.tools,
      skillsVisible: agentRun.skillsVisible,
      mcpServers: agentRun.mcpServers,
    };
    record.usage = agentRun.usage;
    record.turns = agentRun.turns.map(({ finalText, input: _input, ...t }) => ({
      ...t,
      finalTextChars: finalText.length,
      ...(t.isError ? { errorText: finalText.slice(0, 2_000) } : {}),
    }));
    record.clarifyReplies = agentRun.clarifyReplies;
    record.timedOut = agentRun.timedOut;
    fs.writeFileSync(path.join(transcriptDir, "final-message.md"), agentRun.turns.at(-1)?.finalText ?? "");
    copyFiles(
      agentRun.sessionFiles.map((f) => ({ rel: path.basename(f), abs: f, size: 0 })),
      ws.config,
      path.join(transcriptDir, "sessions"),
    );

    log(`${id}: checking ledger state for ${account.address}`);
    const check = await checkRun(spec.tier, account.address, ws.project);
    writeJson(path.join(outDir, "check.json"), check);
    record.check = { status: check.status, failed: check.criteria.filter((c) => !c.pass).map((c) => c.id) };

    const tcResult = await typecheck(ws.project, (args) => {
      const [cmd, argv] = sandboxed(ws, tc.nodeBin, args, ws.postProfile);
      return exec(cmd, argv, { cwd: ws.project, env, timeoutMs: 300_000 });
    });
    writeJson(path.join(outDir, "typecheck.json"), tcResult);

    const skip = ["node_modules", ".git", SKILL_INSTALL_DIR[provider]];
    const all = walkFiles(ws.project, skip);
    const files = all.filter((f) => f.size <= 2_000_000);
    const finalDir = path.join(outDir, "final");
    const unsafe = copyFiles(files, ws.project, finalDir);
    // An agent's .gitignore would hide captured files (dist/, .env) from the
    // results commit, so it is stored under another name.
    const renamed: string[] = [];
    for (const f of walkFiles(finalDir, [])) {
      if (path.basename(f.rel) !== ".gitignore") continue;
      fs.renameSync(f.abs, path.join(path.dirname(f.abs), "_gitignore"));
      renamed.push(f.rel);
    }
    record.capture = { files: files.length - unsafe.length, skippedLarge: all.filter((f) => f.size > 2_000_000).map((f) => f.rel), skippedUnsafe: unsafe, renamedGitignores: renamed };
    const xrplPkg = readJsonInside<{ version?: string }>(ws.project, path.join(ws.project, "node_modules", "xrpl", "package.json"));
    const projectPkg = readJsonInside<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(ws.project, path.join(ws.project, "package.json"));
    record.xrpl = { installedVersion: xrplPkg?.version, dependencySpec: projectPkg?.dependencies?.xrpl ?? projectPkg?.devDependencies?.xrpl };
    if (record.skill) record.skill.hashAfter = hashTree(path.join(ws.project, record.skill.installDir));

    record.infra = classify({ check, transcriptFile: path.join(transcriptDir, "agent.jsonl"), probes, agentErrors: agentErrorTexts(record, transcriptDir) });
    writeJson(path.join(outDir, "infra.json"), record.infra);
    record.status = record.infra.verdict === "infra" ? "infra" : "complete";
    return record;
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
    return record;
  } finally {
    monitor?.stop();
    if (cred) removeCredentialFiles(ws.config, cred);
    record.endedAt = nowIso();
    record.wallClockSeconds = Math.round((Date.now() - started) / 1000);
    if (record.error) record.error = redactText(record.error, secrets);
    const runJson = path.join(outDir, "run.json");
    fs.writeFileSync(runJson, redactedJson(record, secrets));
    record.redactedFiles = redactTree(outDir, secrets);
    fs.writeFileSync(runJson, redactedJson(record, secrets));
    const leaks = leakedSecrets(outDir, secrets);
    if (leaks.length) throw new Error(`secrets survived redaction in ${leaks.join(", ")}; do not commit ${outDir}`);
    if (!opts.keepWorkspace) fs.rmSync(wsRoot, { recursive: true, force: true });
    log(`${id}: ${record.status}${record.check ? ` / ledger check ${record.check.status}` : ""}${record.error ? ` (${record.error})` : ""}`);
  }
}
