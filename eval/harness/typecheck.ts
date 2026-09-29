// Type-checks the agent's final project twice: with its own tsconfig, and with
// strict mode forced on. Uses the project's own TypeScript when it installed
// one, otherwise the harness's.
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR } from "./config.ts";
import { exec, walkFiles } from "./util.ts";

export type TscRun = { config: string; exitCode: number | null; errorCount: number; errorsInProject: number; output: string };
export type TypecheckResult = {
  status: "checked" | "not_typescript";
  tscPath?: string;
  tscVersion?: string;
  tscSource?: "project" | "harness";
  tsFiles: string[];
  project?: TscRun;
  strict?: TscRun;
};

const STRICT_CONFIG = "tsconfig.xrpl-eval-strict.json";
const MAX_OUTPUT = 20_000;

export async function typecheck(projectDir: string, env: NodeJS.ProcessEnv): Promise<TypecheckResult> {
  const tsFiles = walkFiles(projectDir, ["node_modules", ".git", ".claude", ".agents", ".codex"])
    .map((f) => f.rel)
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"));
  if (tsFiles.length === 0) return { status: "not_typescript", tsFiles };
  const own = path.join(projectDir, "node_modules", "typescript", "bin", "tsc");
  const tscPath = fs.existsSync(own) ? own : path.join(EVAL_DIR, "node_modules", "typescript", "bin", "tsc");
  const tscSource = fs.existsSync(own) ? "project" : "harness";
  const tscVersion = (await exec(process.execPath, [tscPath, "--version"], { cwd: projectDir, env })).stdout.trim();
  const hasConfig = fs.existsSync(path.join(projectDir, "tsconfig.json"));
  const run = async (config: string): Promise<TscRun> => {
    const res = await exec(process.execPath, [tscPath, "--noEmit", "--pretty", "false", "-p", config], { cwd: projectDir, env, timeoutMs: 300_000 });
    const output = `${res.stdout}${res.stderr}`;
    const errors = output.split("\n").filter((l) => /error TS\d+/.test(l));
    return {
      config,
      exitCode: res.code,
      errorCount: errors.length,
      errorsInProject: errors.filter((l) => !l.includes("node_modules/")).length,
      output: output.slice(0, MAX_OUTPUT),
    };
  };
  const result: TypecheckResult = { status: "checked", tscPath, tscVersion, tscSource, tsFiles };
  if (hasConfig) result.project = await run("tsconfig.json");
  const strictConfig = hasConfig
    ? { extends: "./tsconfig.json", compilerOptions: { strict: true, noEmit: true } }
    : {
        compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true },
        include: ["**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx"],
        exclude: ["node_modules"],
      };
  const strictPath = path.join(projectDir, STRICT_CONFIG);
  fs.writeFileSync(strictPath, JSON.stringify(strictConfig, null, 2));
  try {
    result.strict = await run(STRICT_CONFIG);
  } finally {
    fs.rmSync(strictPath, { force: true });
  }
  return result;
}
