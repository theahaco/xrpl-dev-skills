// Type-checks the agent's final project twice: with its own tsconfig, and with
// strict mode forced on. Uses the project's own TypeScript when it installed
// one, otherwise the harness's. The compiler always runs inside the sandbox
// (the post-run profile), because the project's tsc is agent-controlled code.
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR } from "./config.ts";
import { type ExecResult, realpathInside, walkFiles } from "./util.ts";

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

// Runs `node <args>` in the project directory, inside the sandbox.
export type SandboxedNode = (args: string[]) => Promise<ExecResult>;

const STRICT_CONFIG = "tsconfig.xrpl-eval-strict.json";
const MAX_OUTPUT = 20_000;
export const HARNESS_TSC = path.join(EVAL_DIR, "node_modules", "typescript", "bin", "tsc");

export async function typecheck(projectDir: string, node: SandboxedNode): Promise<TypecheckResult> {
  const tsFiles = walkFiles(projectDir, ["node_modules", ".git", ".claude", ".agents", ".codex"])
    .map((f) => f.rel)
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"));
  if (tsFiles.length === 0) return { status: "not_typescript", tsFiles };
  const own = path.join(projectDir, "node_modules", "typescript", "bin", "tsc");
  const useOwn = realpathInside(projectDir, own) !== undefined;
  const tscPath = useOwn ? own : HARNESS_TSC;
  const tscVersion = (await node([tscPath, "--version"])).stdout.trim();
  const hasConfig = realpathInside(projectDir, path.join(projectDir, "tsconfig.json")) !== undefined;
  const run = async (config: string): Promise<TscRun> => {
    const res = await node([tscPath, "--noEmit", "--pretty", "false", "-p", config]);
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
  const result: TypecheckResult = { status: "checked", tscPath: useOwn ? "node_modules/typescript/bin/tsc" : "harness", tscVersion, tscSource: useOwn ? "project" : "harness", tsFiles };
  if (hasConfig) result.project = await run("tsconfig.json");
  const strictConfig = hasConfig
    ? { extends: "./tsconfig.json", compilerOptions: { strict: true, noEmit: true } }
    : {
        compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true },
        include: ["**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx"],
        exclude: ["node_modules"],
      };
  const strictPath = path.join(projectDir, STRICT_CONFIG);
  // Unlink first and create exclusively, so a symlink the agent left at this
  // name cannot redirect the write.
  fs.rmSync(strictPath, { force: true });
  fs.writeFileSync(strictPath, JSON.stringify(strictConfig, null, 2), { flag: "wx" });
  try {
    result.strict = await run(STRICT_CONFIG);
  } finally {
    fs.rmSync(strictPath, { force: true });
  }
  return result;
}
