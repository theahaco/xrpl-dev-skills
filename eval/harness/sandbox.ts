// Isolation for agent runs: a macOS Seatbelt profile (sandbox-exec) plus a
// scrubbed environment with a throwaway HOME.
//
// The profile denies every read and write under the operator's home directory,
// /private/tmp and the operator's per-user temp dir, then re-allows only the
// run's own workspace (read/write) and the node toolchain (read-only). That
// covers ~/.jev, ~/.claude, ~/.claude.json, ~/.codex, the theahaco checkouts,
// the firstmate home and this repository, and it also blocks the login
// keychain, whose database lives under ~/Library/Keychains.
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR, FIRSTMATE_HOME, REAL_HOME, THEAHACO_DIR } from "./config.ts";
import { exec, execOk } from "./util.ts";

export type Workspace = {
  root: string; // everything the agent may touch
  project: string; // the agent's working directory
  home: string; // HOME for the agent
  config: string; // CLAUDE_CONFIG_DIR or CODEX_HOME
  tmp: string;
  bin: string; // curated PATH entries
  profile: string; // the .sb file (outside the workspace)
};

export function createWorkspace(root: string, profileDir: string): Workspace {
  const ws: Workspace = {
    root,
    project: path.join(root, "project"),
    home: path.join(root, "home"),
    config: path.join(root, "cfg"),
    tmp: path.join(root, "tmp"),
    bin: path.join(root, "bin"),
    profile: path.join(profileDir, "sandbox.sb"),
  };
  for (const dir of [ws.project, ws.home, ws.config, ws.tmp, ws.bin, path.join(ws.home, ".npm-global", "bin")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(ws.home, ".gitconfig"), "[user]\n\tname = Developer\n\temail = developer@example.invalid\n[init]\n\tdefaultBranch = main\n");
  return ws;
}

export type Toolchain = { nodeBin: string; nodePrefix: string; claude: string; codex: string };

export async function resolveToolchain(): Promise<Toolchain> {
  const nodeBin = fs.realpathSync(process.execPath);
  const nodePrefix = path.dirname(path.dirname(nodeBin));
  const which = async (name: string): Promise<string> => fs.realpathSync((await execOk("/usr/bin/which", [name])).trim());
  return { nodeBin, nodePrefix, claude: await which("claude"), codex: await which("codex") };
}

// PATH for the agent: node, npm, npx and the agent CLI via symlinks, then the
// system and Homebrew directories. Nothing else from the operator's PATH.
export function linkToolchain(ws: Workspace, tc: Toolchain): string {
  const npmCli = path.join(tc.nodePrefix, "lib", "node_modules", "npm", "bin");
  const links: Record<string, string> = {
    node: tc.nodeBin,
    npm: path.join(npmCli, "npm-cli.js"),
    npx: path.join(npmCli, "npx-cli.js"),
    claude: tc.claude,
    codex: tc.codex,
  };
  const corepack = path.join(tc.nodePrefix, "lib", "node_modules", "corepack", "dist", "corepack.js");
  if (fs.existsSync(corepack)) links.corepack = corepack;
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(ws.bin, name);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
  }
  return [ws.bin, path.join(ws.home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

async function operatorTempDir(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const res = await exec("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"]);
  const dir = res.stdout.trim();
  return dir ? fs.realpathSync(dir) : undefined;
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = path.dirname(p);
  while (cur !== path.dirname(cur)) {
    out.push(cur);
    cur = path.dirname(cur);
  }
  return out;
}

const q = (s: string): string => JSON.stringify(s);

export async function writeProfile(ws: Workspace, tc: Toolchain): Promise<void> {
  const home = fs.realpathSync(REAL_HOME);
  const root = fs.realpathSync(ws.root);
  const denied = [home, "/private/tmp", "/private/var/tmp"];
  const userTmp = await operatorTempDir();
  if (userTmp) denied.push(userTmp);
  // Read-only grants: the node prefix (node, npm, and the codex package) and
  // the directory holding the claude binary if it lives under a denied path.
  const readOnly = [tc.nodePrefix, path.dirname(tc.claude), path.dirname(tc.codex)].filter((p) => denied.some((d) => p === d || p.startsWith(`${d}/`)));
  const metadata = new Set<string>();
  for (const p of [root, ...readOnly]) for (const a of ancestors(p)) metadata.add(a);
  // Denied trees that contain the workspace. Tools walk up from the project
  // (node_modules/.bin on npm's PATH, config lookups), and a denied lookup
  // returns EPERM where the tool expects ENOENT: npx then dies with a silent
  // exit 255. Metadata-only access keeps those walks working without letting
  // anything list a directory or read a file.
  const enclosing = denied.filter((d) => root.startsWith(`${d}/`));
  const lines = [
    "(version 1)",
    "(allow default)",
    ...denied.map((d) => `(deny file-read* file-write* (subpath ${q(d)}))`),
    // Later rules win: carve the workspace and toolchain back out.
    `(allow file-read* file-write* (subpath ${q(root)}))`,
    ...[...new Set(readOnly)].map((p) => `(allow file-read* (subpath ${q(p)}))`),
    ...enclosing.map((d) => `(allow file-read-metadata (subpath ${q(d)}))`),
    // lstat on ancestors, needed by realpath(); does not allow listing them.
    ...[...metadata].sort().map((p) => `(allow file-read-metadata (literal ${q(p)}))`),
  ];
  fs.mkdirSync(path.dirname(ws.profile), { recursive: true });
  fs.writeFileSync(ws.profile, `${lines.join("\n")}\n`);
}

export function agentEnv(ws: Workspace, pathVar: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    HOME: ws.home,
    USER: process.env.USER ?? "developer",
    LOGNAME: process.env.USER ?? "developer",
    SHELL: "/bin/zsh",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    PATH: pathVar,
    TMPDIR: `${ws.tmp}/`,
    CLAUDE_CODE_TMPDIR: ws.tmp,
    NPM_CONFIG_PREFIX: path.join(ws.home, ".npm-global"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    ...extra,
  };
}

export function sandboxed(ws: Workspace, cmd: string, args: string[]): [string, string[]] {
  return ["/usr/bin/sandbox-exec", ["-f", ws.profile, cmd, ...args]];
}

export type IsolationCheck = { name: string; expect: "denied" | "allowed"; ok: boolean; detail: string };

function firstFile(dir: string): string | undefined {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isFile()) return p;
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const inner = firstFile(p);
        if (inner) return inner;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Runs inside the same sandbox and environment the agent will get and proves
// the protected paths are unreadable while the workspace and toolchain work.
export async function isolationSelfTest(ws: Workspace, env: NodeJS.ProcessEnv): Promise<IsolationCheck[]> {
  const mustDeny: Array<[string, string]> = [];
  const candidates: Array<[string, string | undefined]> = [
    ["~/.jev", path.join(REAL_HOME, ".jev")],
    ["~/.claude", firstFile(path.join(REAL_HOME, ".claude"))],
    ["~/.claude.json", path.join(REAL_HOME, ".claude.json")],
    ["~/.codex", path.join(REAL_HOME, ".codex", "auth.json")],
    ["theahaco repos", firstFile(THEAHACO_DIR)],
    ["firstmate home", firstFile(FIRSTMATE_HOME)],
    ["eval harness repo", path.join(EVAL_DIR, "package.json")],
  ];
  for (const [name, p] of candidates) if (p && fs.existsSync(p)) mustDeny.push([name, p]);

  const checks: IsolationCheck[] = [];
  const run = async (name: string, expect: "denied" | "allowed", script: string): Promise<void> => {
    const [cmd, args] = sandboxed(ws, "/bin/sh", ["-c", script]);
    const res = await exec(cmd, args, { cwd: ws.project, env, timeoutMs: 60_000 });
    const allowed = res.code === 0;
    checks.push({ name, expect, ok: expect === "allowed" ? allowed : !allowed, detail: (res.stderr || res.stdout).trim().slice(0, 300) });
  };
  for (const [name, p] of mustDeny) await run(`read ${name}`, "denied", `head -c 1 ${JSON.stringify(p)} >/dev/null`);
  await run("list operator home", "denied", `ls ${JSON.stringify(REAL_HOME)} >/dev/null`);
  await run("list /private/tmp", "denied", "ls /private/tmp >/dev/null");
  await run("keychain: Claude credentials", "denied", "security find-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1");
  await run("write outside workspace", "denied", "echo x > /private/tmp/.xrpl-eval-escape-probe");
  const probe = path.join(ws.project, ".isolation-probe.mjs");
  fs.writeFileSync(probe, "console.log(process.version)\n");
  await run("node runs a project file", "allowed", `node ${JSON.stringify(probe)}`);
  await run("npm available", "allowed", "npm --version");
  // npx spawns through a PATH that walks up out of the workspace.
  await run("npx runs a command", "allowed", "npm exec --call \"node --version\"");
  await run("git available", "allowed", "git --version");
  await run("registry reachable", "allowed", "npm view xrpl version --prefer-online >/dev/null");
  fs.rmSync(probe, { force: true });
  return checks;
}
