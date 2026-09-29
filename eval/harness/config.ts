import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TASKS_DIR = path.join(EVAL_DIR, "tasks");
export const RUBRIC_PATH = path.join(EVAL_DIR, "rubric", "rubric.json");
export const ESTIMATES_PATH = path.join(EVAL_DIR, "budget", "estimates.json");
export const RESULTS_DIR = process.env.XRPL_EVAL_RESULTS_DIR ?? path.join(EVAL_DIR, "results");
export const CACHE_DIR = path.join(EVAL_DIR, ".cache");

// Agent workspaces live outside every repository and outside $HOME, under an
// opaque name, so nothing in the path tells the agent which arm it is in.
export const SANDBOX_ROOT = process.env.XRPL_EVAL_SANDBOX_ROOT ?? "/private/tmp/ws";

export const REAL_HOME = os.homedir();
export const FIRSTMATE_HOME = process.env.FIRSTMATE_HOME ?? path.join(REAL_HOME, "c", "willemneal", "firstmate");
export const THEAHACO_DIR = process.env.XRPL_EVAL_THEAHACO_DIR ?? path.join(REAL_HOME, "c", "theahaco");

export const TIERS = ["medium", "complex"] as const;
export type Tier = (typeof TIERS)[number];

export const TIME_CAP_MINUTES: Record<Tier, number> = { medium: 40, complex: 90 };
export const REPS: Record<Tier, number> = { medium: 2, complex: 3 };

export const ARMS = ["bare", "skill", "research", "skill-research"] as const;
export type Arm = (typeof ARMS)[number];
export const armHasSkill = (arm: Arm): boolean => arm === "skill" || arm === "skill-research";
export const armHasResearch = (arm: Arm): boolean => arm === "research" || arm === "skill-research";

export type Provider = "claude" | "codex";

export type AgentSpec = {
  provider: Provider;
  // Value for `claude --model`; Codex runs with its own default model.
  modelAlias?: string;
  // The resolved model id must match, or the run is flagged.
  expectModel?: RegExp;
};

export const AGENTS = {
  "claude-opus": { provider: "claude", modelAlias: "opus", expectModel: /^claude-opus-5-5/ },
  "claude-sonnet": { provider: "claude", modelAlias: "sonnet", expectModel: /^claude-sonnet-5/ },
  codex: { provider: "codex" },
} as const satisfies Record<string, AgentSpec>;
export type AgentName = keyof typeof AGENTS;
export const AGENT_NAMES = Object.keys(AGENTS) as AgentName[];

export const UPSTREAM_SKILL_REPO = "https://github.com/XRPL-Commons/xrpl-dev-skills";
export const UPSTREAM_SKILL_REF = "main";
// Where each agent loads a project-level skill from. Codex 0.158 reads
// .agents/skills and .codex/skills but not .claude/skills (see README).
export const SKILL_INSTALL_DIR: Record<Provider, string> = {
  claude: ".claude/skills/xrpl-dev",
  codex: ".agents/skills/xrpl-dev",
};

export const TESTNET_RPC_URLS = ["https://s.altnet.rippletest.net:51234/", "https://testnet.xrpl-labs.com/"];
export const FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";

export const CLARIFY_REPLY = "Proceed with your best judgment.";
export const MAX_CLARIFY_REPLIES = 3;
export const DEFAULT_CONCURRENCY = 6;
export const MAX_INFRA_RERUNS = 2;

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_KEY_PATH = path.join(REAL_HOME, ".jev");
export const JEV_CONFIDENCE_FLOOR = 0.6;
// Measured 2026-09-28: requests above ~32.7k input tokens fail with
// max_tokens_exceeded. Stay well under it.
export const JEV_MAX_INPUT_TOKENS = 24_000;
export const MODEL_SCORER_ALIAS = process.env.XRPL_EVAL_SCORER_MODEL ?? "opus";

export const BUDGET_FLOOR_PCT = 40;
export const BUDGET_MARGIN = 1.25;
export const BUDGET_WARN_PCT = 55;
