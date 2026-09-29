// Scrubs secrets from everything written under a results directory before it
// can be committed: the harness's known secrets (the funded seed, copied OAuth
// tokens) plus anything shaped like an XRPL seed or private key, since agents
// print the keys of the holder wallets they create.
import fs from "node:fs";
import { isProbablyText, walkFiles } from "./util.ts";

export const SEED_PLACEHOLDER = "<TESTNET_SEED_REDACTED>";
const TOKEN_PLACEHOLDER = "<CREDENTIAL_REDACTED>";
const KEY_PLACEHOLDER = "<TESTNET_PRIVATE_KEY_REDACTED>";

const B58 = "[1-9A-HJ-NP-Za-km-z]";
// Word boundaries that also hold right after a JSON escape such as \n, where
// \b fails because the escape ends in a letter.
const START = "(?:(?<=\\\\[nrtbf])|(?<![0-9A-Za-z]))";
const END = "(?![0-9A-Za-z])";
const PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`${START}sEd${B58}{28}${END}`, "g"), SEED_PLACEHOLDER],
  [new RegExp(`${START}s${B58}{28}${END}`, "g"), SEED_PLACEHOLDER],
  [new RegExp(`${START}ED[0-9A-Fa-f]{64}${END}`, "g"), KEY_PLACEHOLDER],
  [new RegExp(`${START}00[0-9A-Fa-f]{64}${END}`, "g"), KEY_PLACEHOLDER],
];

export type Secret = { value: string; kind: "seed" | "token" };

export function redactText(text: string, secrets: Secret[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.value.length < 8) continue;
    out = out.split(s.value).join(s.kind === "seed" ? SEED_PLACEHOLDER : TOKEN_PLACEHOLDER);
  }
  for (const [re, placeholder] of PATTERNS) out = out.replace(re, placeholder);
  return out;
}

// For writing an in-memory record: the same redaction as the files get, so a
// write after redactTree cannot put a pattern-only secret back.
export function redactedJson(value: unknown, secrets: Secret[]): string {
  return `${redactText(JSON.stringify(value, null, 2), secrets)}\n`;
}

export function redactTree(dir: string, secrets: Secret[]): number {
  let changed = 0;
  for (const f of walkFiles(dir, [])) {
    const buf = fs.readFileSync(f.abs);
    if (!isProbablyText(buf)) continue;
    const before = buf.toString("utf8");
    const after = redactText(before, secrets);
    if (after !== before) {
      fs.writeFileSync(f.abs, after);
      changed++;
    }
  }
  return changed;
}

// Files that still contain a known secret after redaction.
export function leakedSecrets(dir: string, secrets: Secret[]): string[] {
  const leaks: string[] = [];
  for (const f of walkFiles(dir, [])) {
    const text = fs.readFileSync(f.abs, "utf8");
    if (secrets.some((s) => s.value.length >= 8 && text.includes(s.value))) leaks.push(f.rel);
  }
  return leaks;
}
