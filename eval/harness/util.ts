import { spawn, type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ExecResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean };

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  stdoutFile?: string;
  stderrFile?: string;
  onStdoutLine?: (line: string) => void;
};

// Runs a command in its own process group so a timeout can kill everything it
// started. stdout/stderr are buffered unless routed to files.
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] };
    const child = spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let pending = "";
    const outStream = opts.stdoutFile ? fs.createWriteStream(opts.stdoutFile, { flags: "a" }) : undefined;
    const errStream = opts.stderrFile ? fs.createWriteStream(opts.stderrFile, { flags: "a" }) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (outStream) outStream.write(chunk);
      else stdout += text;
      if (opts.onStdoutLine) {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) opts.onStdoutLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errStream) errStream.write(chunk);
      else stderr += chunk.toString("utf8");
    });
    child.stdin?.end(opts.input ?? "");
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, "SIGTERM");
        setTimeout(() => killGroup(child.pid, "SIGKILL"), 15_000).unref();
      }, opts.timeoutMs);
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending);
      // Background jobs the agent left running share the group; end them too.
      killGroup(child.pid, "SIGKILL");
      const done = () => resolve({ code, signal, stdout, stderr, timedOut });
      Promise.all([closeStream(outStream), closeStream(errStream)]).then(done, done);
    });
  });
}

function closeStream(stream: fs.WriteStream | undefined): Promise<void> {
  return new Promise((resolve) => (stream ? stream.end(resolve) : resolve()));
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

export async function execOk(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const res = await exec(cmd, args, opts);
  if (res.code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function readJsonIfExists<T>(file: string): T | undefined {
  return fs.existsSync(file) ? readJson<T>(file) : undefined;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export type WalkEntry = { rel: string; abs: string; size: number };

// Lists files under `root`, skipping any directory whose relative path matches
// one of `skipDirs` (exact relative path or bare directory name).
export function walkFiles(root: string, skipDirs: string[]): WalkEntry[] {
  const out: WalkEntry[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name) || skipDirs.includes(rel)) continue;
        visit(abs);
      } else if (entry.isFile()) {
        out.push({ rel, abs, size: fs.statSync(abs).size });
      }
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function copyFiles(entries: WalkEntry[], destRoot: string): void {
  for (const e of entries) {
    const dest = path.join(destRoot, e.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(e.abs, dest);
  }
}

export function hashTree(root: string): string {
  const h = createHash("sha256");
  for (const e of walkFiles(root, [])) {
    h.update(e.rel);
    h.update(fs.readFileSync(e.abs));
  }
  return h.digest("hex");
}

export function isProbablyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

export function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}
