// Type-checks the agent's final project twice: with its own tsconfig, and with
// strict mode forced on. Uses the project's own TypeScript when it installed
// one, otherwise the harness's. The compiler always runs inside the sandbox
// (the post-run profile), because the project's tsc is agent-controlled code.
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR } from "./config.ts";
import { type ExecResult, readFileInside, realpathInside, walkFiles } from "./util.ts";

export type TscRun = { config: string; exitCode: number | null; errorCount: number; errorsInProject: number; output: string };
export type ProjectStrictness = {
  // Where the effective options came from: `tsc --showConfig` (extends
  // resolved), the raw tsconfig.json, or nothing to read.
  source: "showConfig" | "tsconfig.json" | "none";
  strict?: boolean;
  // Strict-family options the project explicitly turned off. Any entry means
  // the agent's own `tsc` was not checking in full strict mode.
  // Also lists `noCheck: true`, which skips semantic checking altogether.
  optOuts: string[];
};
export type TypecheckResult = {
  status: "checked" | "not_typescript";
  tscPath?: string;
  tscVersion?: string;
  tscSource?: "project" | "harness";
  tsFiles: string[];
  projectStrictness?: ProjectStrictness;
  project?: TscRun;
  strict?: TscRun;
  // The generated config the strict run used.
  strictConfig?: Record<string, unknown>;
  // Set when re-run after the fact by `cli.ts typecheck`, with dependencies
  // reinstalled from the committed lockfile.
  rebuilt?: { from: string; at: string };
};

// Runs `node <args>` in the project directory, inside the sandbox.
export type SandboxedNode = (args: string[]) => Promise<ExecResult>;

const STRICT_CONFIG = "tsconfig.xrpl-eval-strict.json";
const MAX_OUTPUT = 20_000;
export const HARNESS_TSC = path.join(EVAL_DIR, "node_modules", "typescript", "bin", "tsc");

// `strict: true` only sets defaults: an explicit `strictNullChecks: false`
// in the project's config still wins. The strict run sets every member of the
// family explicitly. strictBuiltinIteratorReturn exists from TypeScript 5.6.
function atLeast(tscVersion: string | undefined, major: number, minor: number): boolean {
  const m = /(\d+)\.(\d+)/.exec(tscVersion ?? "");
  const [maj, min] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return maj > major || (maj === major && min >= minor);
}

export function strictFamily(tscVersion: string | undefined): string[] {
  const family = [
    "noImplicitAny",
    "noImplicitThis",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "alwaysStrict",
    "useUnknownInCatchVariables",
  ];
  if (atLeast(tscVersion, 5, 6)) family.push("strictBuiltinIteratorReturn");
  return family;
}

// Every strict-family option on, plus `noCheck: false` (TypeScript 5.6+):
// an inherited `noCheck: true` would skip checking altogether.
export function strictOverrides(tscVersion: string | undefined): Record<string, boolean> {
  const overrides: Record<string, boolean> = Object.fromEntries([["strict", true], ...strictFamily(tscVersion).map((k) => [k, true] as const)]);
  if (atLeast(tscVersion, 5, 6)) overrides.noCheck = false;
  return overrides;
}

export function strictnessOf(compilerOptions: Record<string, unknown>, tscVersion: string | undefined): Omit<ProjectStrictness, "source"> {
  const strict = typeof compilerOptions.strict === "boolean" ? compilerOptions.strict : undefined;
  const optOuts = ["strict", ...strictFamily(tscVersion)].filter((k) => compilerOptions[k] === false).map((k) => `${k}: false`);
  if (compilerOptions.noCheck === true) optOuts.push("noCheck: true");
  return { strict, optOuts };
}

// tsconfig files are JSONC: comments and trailing commas are allowed.
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function projectStrictness(projectDir: string, node: SandboxedNode, tscPath: string, tscVersion: string): Promise<ProjectStrictness> {
  const shown = await node([tscPath, "--showConfig", "-p", "tsconfig.json"]);
  if (shown.code === 0) {
    try {
      const cfg = JSON.parse(shown.stdout) as { compilerOptions?: Record<string, unknown> };
      return { source: "showConfig", ...strictnessOf(cfg.compilerOptions ?? {}, tscVersion) };
    } catch {
      // Fall through to the raw file.
    }
  }
  const raw = readFileInside(projectDir, path.join(projectDir, "tsconfig.json"), 1_000_000);
  if (raw === undefined) return { source: "none", optOuts: [] };
  try {
    const cfg = parseJsonc(raw) as { compilerOptions?: Record<string, unknown> };
    return { source: "tsconfig.json", ...strictnessOf(cfg.compilerOptions ?? {}, tscVersion) };
  } catch {
    return { source: "none", optOuts: [] };
  }
}

export async function typecheck(projectDir: string, node: SandboxedNode, harnessTsc = HARNESS_TSC): Promise<TypecheckResult> {
  const all = walkFiles(projectDir, ["node_modules", ".git", ".claude", ".agents", ".codex"]).map((f) => f.rel);
  const tsFiles = all.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !/\.d\.[mc]?ts$/.test(f));
  // The agent's own declaration files, not ones a build emitted.
  const declarations = all.filter((f) => /\.d\.[mc]?ts$/.test(f) && !/^(dist|build|out|coverage)\//.test(f));
  if (tsFiles.length === 0) return { status: "not_typescript", tsFiles };
  const own = path.join(projectDir, "node_modules", "typescript", "bin", "tsc");
  const useOwn = realpathInside(projectDir, own) !== undefined;
  const tscPath = useOwn ? own : harnessTsc;
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
  if (hasConfig) {
    result.projectStrictness = await projectStrictness(projectDir, node, tscPath, tscVersion);
    result.project = await run("tsconfig.json");
  }
  // Checks exactly the discovered sources: an inherited files/include/exclude
  // could otherwise leave some out and report them clean. rootDir "." keeps a
  // source outside the project's rootDir from failing on layout alone.
  const overrides = { ...strictOverrides(tscVersion), noEmit: true, rootDir: "." };
  const inputs = { files: [...tsFiles, ...declarations], include: [] as string[] };
  const strictConfig = hasConfig
    ? { extends: "./tsconfig.json", compilerOptions: overrides, ...inputs }
    : { compilerOptions: { ...overrides, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true }, ...inputs };
  result.strictConfig = strictConfig;
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
