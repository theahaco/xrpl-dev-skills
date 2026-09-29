// Isolation for agent runs: a macOS Seatbelt profile (sandbox-exec) plus a
// scrubbed environment with a throwaway HOME.
//
// The profile denies every write outside the run's workspace (so an agent
// cannot tamper with binaries the harness later runs unsandboxed) and every
// read under the operator's home directory, /private/tmp and the operator's
// per-user temp dir, then re-allows the run's own workspace (read/write) and
// the node toolchain (read-only). That covers ~/.jev, ~/.claude,
// ~/.claude.json, ~/.codex, the theahaco checkouts, the firstmate home and
// this repository, and it also blocks the login keychain, whose database lives
// under ~/Library/Keychains.
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
  profile: string; // the agent's .sb file (outside the workspace)
  postProfile: string; // same, plus the harness's TypeScript, for post-run steps
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
    postProfile: path.join(profileDir, "sandbox-post.sb"),
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

// `extraReadOnly` is for post-run profiles only; the agent never runs under one.
export async function writeProfile(ws: Workspace, tc: Toolchain, file: string, extraReadOnly: string[] = []): Promise<void> {
  const home = fs.realpathSync(REAL_HOME);
  const root = fs.realpathSync(ws.root);
  const denied = [home, "/private/tmp", "/private/var/tmp"];
  const userTmp = await operatorTempDir();
  if (userTmp) denied.push(userTmp);
  // Read-only grants: the node prefix (node, npm, and the codex package) and
  // the directory holding the claude binary if it lives under a denied path.
  const readOnly = [tc.nodePrefix, path.dirname(tc.claude), path.dirname(tc.codex), ...extraReadOnly.map((p) => fs.realpathSync(p))].filter((p) =>
    denied.some((d) => p === d || p.startsWith(`${d}/`)),
  );
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
    '(deny file-write* (subpath "/"))',
    ...denied.map((d) => `(deny file-read* file-write* (subpath ${q(d)}))`),
    // Later rules win: carve the workspace, devices and toolchain back out.
    '(allow file-write* (subpath "/dev"))',
    `(allow file-read* file-write* (subpath ${q(root)}))`,
    ...[...new Set(readOnly)].map((p) => `(allow file-read* (subpath ${q(p)}))`),
    ...enclosing.map((d) => `(allow file-read-metadata (subpath ${q(d)}))`),
    // lstat on ancestors, needed by realpath(); does not allow listing them.
    ...[...metadata].sort().map((p) => `(allow file-read-metadata (literal ${q(p)}))`),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
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

export function sandboxed(ws: Workspace, cmd: string, args: string[], profile = ws.profile): [string, string[]] {
  return ["/usr/bin/sandbox-exec", ["-f", profile, cmd, ...args]];
}

// Kills anything still running from the workspace after the agent exits:
// processes that left the agent's process group (setsid, nohup) would
// otherwise keep changing files while the harness copies them.
export async function killStrays(ws: Workspace): Promise<number> {
  const root = fs.realpathSync(ws.root);
  const pids = new Set<number>();
  const cwd = await exec("/usr/sbin/lsof", ["-a", "-d", "cwd", "-F", "pn"]);
  let pid = 0;
  for (const line of cwd.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && (line.slice(1) === root || line.slice(1).startsWith(`${root}/`))) pids.add(pid);
  }
  const ps = await exec("/bin/ps", ["-axo", "pid=,command="]);
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m?.[1] && m[2] && (m[2].includes(root) || m[2].includes(ws.root))) pids.add(Number(m[1]));
  }
  pids.delete(process.pid);
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return pids.size;
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
export async function isolationSelfTest(ws: Workspace, tc: Toolchain, env: NodeJS.ProcessEnv): Promise<IsolationCheck[]> {
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
  // Binaries the harness itself runs later, outside the sandbox.
  for (const dir of new Set([path.dirname(tc.claude), path.dirname(tc.nodeBin), "/opt/homebrew/bin", "/usr/local/bin"])) {
    if (fs.existsSync(dir)) await run(`write ${dir}`, "denied", `touch ${JSON.stringify(path.join(dir, ".xrpl-eval-escape-probe"))}`);
  }
  if (mustDeny[0]) await run("hard-link a protected file", "denied", `ln ${JSON.stringify(mustDeny[0][1])} ./.xrpl-eval-link-probe`);
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
