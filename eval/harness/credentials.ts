// Builds the throwaway credential files an agent run gets. Only short-lived
// access tokens are copied: refresh tokens stay with the operator so a child
// run can never rotate them and log the operator out.
import fs from "node:fs";
import path from "node:path";
import { REAL_HOME } from "./config.ts";
import { exec } from "./util.ts";

export type Credential = { files: Record<string, string>; secrets: string[]; expiresAt: number };

async function claudeCredentialJson(): Promise<string> {
  if (process.platform === "darwin") {
    const res = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", process.env.USER ?? "", "-w"]);
    if (res.code === 0 && res.stdout.trim()) return res.stdout.trim();
  }
  const file = path.join(REAL_HOME, ".claude", ".credentials.json");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  throw new Error("no Claude Code login found in the keychain or ~/.claude/.credentials.json; run `claude` once and log in");
}

type ClaudeOauth = { accessToken: string; expiresAt: number; refreshToken?: string; refreshTokenExpiresAt?: number; [k: string]: unknown };

// `minValidMs`: how long the copied access token must stay valid (run cap plus
// margin). Claude Code access tokens live about 8 hours.
export async function claudeCredential(minValidMs: number): Promise<Credential> {
  const parsed = JSON.parse(await claudeCredentialJson()) as { claudeAiOauth?: ClaudeOauth };
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("Claude credential has no OAuth access token");
  const remaining = oauth.expiresAt - Date.now();
  if (remaining < minValidMs) {
    throw new CredentialTooShortError(
      "claude",
      oauth.expiresAt,
      `Claude access token expires in ${Math.round(remaining / 60_000)} min, need ${Math.round(minValidMs / 60_000)} min. ` +
        "It refreshes when it expires and any Claude Code session makes a request; retry after that.",
    );
  }
  const { refreshToken: _r, refreshTokenExpiresAt: _re, ...rest } = oauth;
  return {
    files: { ".credentials.json": JSON.stringify({ claudeAiOauth: rest }) },
    secrets: [oauth.accessToken],
    expiresAt: oauth.expiresAt,
  };
}

type CodexAuth = {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { access_token: string; id_token: string; refresh_token?: string; account_id?: string };
  last_refresh?: string;
};

function jwtExpiry(token: string): number {
  const payload = token.split(".")[1] ?? "";
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
  return (json.exp ?? 0) * 1000;
}

export async function codexCredential(minValidMs: number): Promise<Credential> {
  const file = path.join(process.env.CODEX_HOME ?? path.join(REAL_HOME, ".codex"), "auth.json");
  if (!fs.existsSync(file)) throw new Error(`no Codex login at ${file}; run \`codex login\``);
  const auth = JSON.parse(fs.readFileSync(file, "utf8")) as CodexAuth;
  const tokens = auth.tokens;
  if (!tokens?.access_token) {
    // Never copied: the sandbox allows network access, so a key in the
    // agent's config dir could be exfiltrated and reused indefinitely. Runs
    // only ever get credentials that expire.
    if (auth.OPENAI_API_KEY) {
      throw new Error(
        "Codex is logged in with an OpenAI API key. The harness only hands agents expiring access tokens and will not copy a long-lived API key into an agent's workspace; there is no supported scoped, temporary API credential. Log in with ChatGPT (`codex login`) and retry.",
      );
    }
    throw new Error("Codex auth.json has no ChatGPT tokens; run `codex login`");
  }
  const expiresAt = jwtExpiry(tokens.access_token);
  if (expiresAt - Date.now() < minValidMs) {
    throw new CredentialTooShortError("codex", expiresAt, `Codex access token expires in ${Math.round((expiresAt - Date.now()) / 60_000)} min; run any codex command to refresh it, then retry.`);
  }
  // Empty refresh token plus a fresh last_refresh: the child neither needs nor
  // can perform a refresh during a run.
  const copy: CodexAuth = {
    auth_mode: auth.auth_mode,
    OPENAI_API_KEY: null,
    tokens: { ...tokens, refresh_token: "" },
    last_refresh: new Date().toISOString(),
  };
  return {
    files: { "auth.json": JSON.stringify(copy) },
    secrets: [tokens.access_token, tokens.id_token].filter((s) => s.length > 0),
    expiresAt,
  };
}

export class CredentialTooShortError extends Error {
  readonly provider: string;
  readonly expiresAt: number;
  constructor(provider: string, expiresAt: number, message: string) {
    super(message);
    this.provider = provider;
    this.expiresAt = expiresAt;
  }
}

export function writeCredentialFiles(configDir: string, cred: Credential): void {
  fs.mkdirSync(configDir, { recursive: true });
  for (const [name, content] of Object.entries(cred.files)) {
    fs.writeFileSync(path.join(configDir, name), content, { mode: 0o600 });
  }
}

export function removeCredentialFiles(configDir: string, cred: Credential): void {
  for (const name of Object.keys(cred.files)) fs.rmSync(path.join(configDir, name), { force: true });
}
