# XRPL AI tooling eval

A harness that stress-tests AI coding agents on XRP Ledger work. Each run hands one agent one task and scores what it did on testnet. The experiment varies three things:

- **Task tier.** `medium` issues an MPT, authorizes a holder, pays it and reads balances back. `complex` builds a compliance-grade MPT issuer with clawback, bans, per-holder freeze and global freeze. The prompts are in [`tasks/`](tasks/), word for word as the agents see them.
- **Arm.** A 2x2 grid: the official [`xrpl-dev` skill](https://github.com/XRPL-Commons/xrpl-dev-skills) installed or not, crossed with a fixed [deep-research preamble](tasks/research-preamble.md) or not. The arms are `bare`, `skill`, `research` and `skill-research`.
- **Agent.** `claude-opus` (Claude Code, `--model opus`), `claude-sonnet` (Claude Code, `--model sonnet`) and `codex` (Codex CLI). Each runs at its out-of-the-box default effort. The resolved model and CLI version are recorded per run.

Everything targets the released `xrpl` package from npm, TypeScript in strict mode, and XRPL testnet.

## Setup

Requirements: macOS (the isolation uses `sandbox-exec`), Node 24+, `claude` and `codex` logged in as the operator, `quota-axi`, and a Jev key in `~/.jev`.

```sh
cd eval
npm install
npm test                       # unit tests for the pure logic
npm run typecheck              # the harness itself is strict TypeScript
node harness/cli.ts selftest   # proves the sandbox before any agent runs
```

## Running

A single run, for example the smoke run committed under [`results/`](results/):

```sh
node harness/cli.ts run --agent claude-sonnet --tier medium --arm bare --rep 1 --estimate-pct 1
```

The committed smoke run passed all eight medium ledger criteria. Sonnet 5 finished in 238 s, with about 2.1M cached input tokens and 15.7k output tokens ($0.75 at list price). Its rubric scores flag a hardcoded seed and non-existent xrpl.js names tried mid-run. It was scored with `--calibrate`, and Jev and the model scorer agreed on all 11 items. Its one `/tmp` write shows up as a sandbox denial in `infra.json`.

A **set** is one agent on one tier: every arm and every rep, so 8 runs for medium (4 arms x 2 reps) and 12 for complex (4 x 3). Runs go six at a time:

```sh
node harness/cli.ts set --agent claude-opus --tier complex
node harness/cli.ts set --sets claude-sonnet:medium,claude-opus:medium   # several sets, one shared pool
```

A set skips runs that already have results, so re-running the command resumes it. Before starting, `set` runs the budget gate described below and exits with status 3 if the gate refuses.

If a run ended in a harness `error` or was interrupted, `set` moves its directory to `...__aborted<n>` and runs it again.

Other commands:

| Command | What it does |
| --- | --- |
| `budget --agent A --tier T [--estimate-pct P]` | Prints the gate decision for a set without running it. |
| `check [run-dir...]` | Re-reads testnet for finished runs. Use it after a checker infra error. |
| `typecheck [run-dir...]` | Re-runs the typecheck for finished runs, reinstalling dependencies from the committed `final/` lockfile inside the sandbox. Use it after the typecheck logic changes. |
| `score [run-dir...] [--calibrate]` | Scores runs against the rubric. `--calibrate` sends every item to both scorers. |
| `agreement [run-dir...]` | Reports Jev vs. model-scorer agreement over items both scored. |
| `selftest` | Runs the isolation self-test in a throwaway workspace. |

With no run directories given, `check`, `score` and `agreement` process everything under `results/`.

## What one run does

1. Resolves the credentials. The Claude OAuth access token comes from the macOS keychain; the Codex tokens come from `~/.codex/auth.json`. The copies carry no refresh token (see Isolation).
2. Creates a workspace at `/private/tmp/ws/<random>/` with `project/` (the agent's cwd, an empty `git init` repo), `home/` (its `HOME`), `cfg/` (its `CLAUDE_CONFIG_DIR` or `CODEX_HOME`), `tmp/` and `bin/`. The random name keeps the arm out of any path the agent can see.
3. For skill arms, shallow-clones upstream `main` of XRPL-Commons/xrpl-dev-skills and records the commit. It then runs upstream's own `install.sh` from a `git archive` of exactly that commit, inside the same sandbox the agent gets, so the installer can only write into the workspace. The installer's SHA-256 is recorded next to the commit in `run.json`, and the installer copy is removed before the agent starts.
   - Claude: `install.sh --project`, which puts the skill in `.claude/skills/xrpl-dev`.
   - Codex: `install.sh --path .agents/skills/xrpl-dev`. The installer has no Codex option; see the findings.
4. Runs the isolation self-test inside the sandbox. The run aborts if any check fails.
5. Snapshots testnet (`server_info`, and the enabled amendments from `feature`), then funds a fresh account from the faucet. Faucet or rippled failure at this point is an infrastructure failure, not an agent failure.
6. Builds the prompt from the research preamble (research arms only), the task text and [`tasks/environment.md`](tasks/environment.md) filled with the funded address and seed.
7. Launches the agent inside the sandbox with the tier's time cap (40 min medium, 90 min complex):
   - Claude: `claude -p --model <alias> --dangerously-skip-permissions --strict-mcp-config --output-format stream-json --verbose`, with the prompt on stdin.
   - Codex: `codex exec --json --dangerously-bypass-approvals-and-sandbox --disable apps -C project -`.

   If a turn ends before `result.json` exists and the final message asks a question anywhere in its prose (code and URLs ignored), the harness resumes the session with the fixed reply "Proceed with your best judgment." It does this up to three times, within the same time cap. A health monitor probes testnet every 30 s for the whole run, and weekly quota is read before and after.
8. Runs the ledger checker, type-checks the project, copies the final code, classifies infrastructure failures, and scrubs secrets from everything it wrote.

## Isolation

Agents must not be able to read `~/.jev`, `~/.claude`, `~/.codex`, the theahaco repositories, the firstmate home, or this repository. Every agent process runs under `sandbox-exec` with a generated Seatbelt profile; each run's copy is in `results/<run>/sandbox.sb`. The profile allows everything by default, then:

- denies every write outside the run's workspace and `/dev`, so an agent cannot tamper with binaries the harness later runs outside the sandbox (`git`, `claude`, `node`);
- denies all reads under the operator's home directory, `/private/tmp`, `/private/var/tmp` and the operator's per-user temp dir;
- re-allows read/write on the run's own workspace, and read-only on the node toolchain;
- allows `lstat` (metadata only) on the ancestors of those paths, because node's `realpath` fails without it;
- allows metadata-only lookups anywhere under `/private/tmp`. npm puts every ancestor's `node_modules/.bin` on its `PATH`, and a denied lookup returns `EPERM` instead of `ENOENT`, which makes `npx` and `npm exec` die with a silent exit 255. Metadata access does not allow listing a directory or reading a file.

Packages other lanes leave in `/private/tmp/node_modules` are therefore visible to lookups but not usable. A command that would only be found there fails with "permission denied" where a clean machine says "not found"; `npx` falls back to installing from the registry, as it would on a clean machine.

Agents still cannot write to `/tmp` directly: another lane's files, or another concurrent run's workspace, would otherwise be readable. `TMPDIR` points at the run's own `tmp/`, so `mktemp` and `os.tmpdir()` work. `TMPPREFIX` points there too, because zsh keeps here-document temp files under `/tmp/zsh` by default; without it, every `cat <<EOF` in an agent's shell failed (fixed after the first grid pass). Only hardcoded `/tmp/...` paths fail. The infra classifier records such hits as `signals.sandboxDenials` in `infra.json`, so the report can treat them as environment friction. They never count as an infra failure. The self-test checks both directions before every run: every protected read, writes to `/tmp` and to the directories holding `claude`, `node` and Homebrew's binaries, and hard-linking a protected file must fail, while running a project file, `npm`, `npm exec`, `git`, zsh and bash here-documents, and the npm registry must work.

**After the agent exits,** the harness kills anything still running from the workspace (found by working directory and command line), since processes that left the agent's process group could otherwise keep changing files during post-processing. The agent's `tsc` is agent-controlled code, so type-checking runs under a second profile (`sandbox-post.sb`), which is the same plus read-only access to the harness's own TypeScript. Every file the harness reads from the workspace (`result.json`, `package.json`, the CLI's session files, the final code) is resolved first and skipped if it points outside the workspace, so a planted symlink cannot make the harness copy or echo another file. Session discovery happens only after the stray-process sweep, never follows links, and skips session files over 64 MB. The upstream installer must be a regular file before the harness hashes it.

Denying the home directory also blocks the login keychain, since its database is under `~/Library/Keychains`, so an agent cannot pull the operator's stored credentials with `security`. On top of the profile, the environment is rebuilt from scratch: no inherited variables, a throwaway `HOME`, and a `PATH` of symlinked `node`/`npm`/`npx`/agent CLI plus the system directories.

Claude runs with `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `--strict-mcp-config`, and Codex with `--disable apps`, so neither loads account-level connectors. The only skills an agent sees are the CLI's built-ins and, in skill arms, the upstream skill.

Codex's own Seatbelt sandbox cannot nest inside another one, so Codex runs with its sandbox bypassed and the outer profile is the boundary. Claude runs in bypass-permissions mode for the same reason: the run is unattended and the outer sandbox does the confining.

**Credentials.** A fresh `CLAUDE_CONFIG_DIR` is not logged in, because Claude Code keeps its login in the keychain. The harness copies the operator's current access token into `cfg/.credentials.json` and strips the refresh token. It does the same for Codex's `auth.json`: `refresh_token` is blanked and `last_refresh` is set to now. A Codex login that uses an OpenAI API key is refused, not copied. The sandbox allows network access, so a long-lived key in an agent's workspace could be exfiltrated and reused, and there is no scoped, temporary API credential to hand over instead. A child run can therefore never rotate a refresh token and log the operator out. The cost is that a run needs an access token valid for its cap plus 20 minutes. Claude tokens live about 8 hours and Codex tokens about 10 days. When the Claude token has too little life left, the run refuses and says so; any Claude Code session refreshes the token once it expires. Token files are deleted when the run ends, and tokens and seeds are redacted from results.

## Results layout

One directory per run, named `<tier>__<agent>__<arm>__r<rep>`. A run that failed on infrastructure is moved aside to `...__infra<n>`, and its re-run records `rerunOf` so it is flagged.

| File | Contents |
| --- | --- |
| `run.json` | Spec, status, timings, CLI/model/effort, the skill commit and install hashes, funded address, network snapshot, token usage per turn, clarify replies, quota before/after, installed `xrpl` version, stray processes killed, what the capture skipped, and a summary of the check and infra verdicts. |
| `prompt.md` | The exact prompt, seed redacted. |
| `transcript/agent.jsonl` | The CLI's event stream (Claude stream-json or Codex `--json`), with harness `turn_start`/`turn_end` markers. |
| `transcript/sessions/` | The CLI's own session file(s). |
| `transcript/final-message.md`, `transcript/stderr.log` | The last agent message, and stderr. |
| `final/` | The final project minus `node_modules`, `.git` and the installed skill. Any `.gitignore` the agent wrote is stored as `_gitignore`, so it cannot hide captured files from the results commit. |
| `check.json` | Ledger checker result, per criterion. |
| `typecheck.json` | `tsc` output with the project's config, and with strict mode forced on. The forced run's generated config (`strictConfig`) inherits the project's config but sets `strict` and every strict-family option explicitly. An explicit `strictNullChecks: false` in the project would otherwise still win. The forced run also sets `noCheck: false` on TypeScript 5.6+ and lists every discovered source in `files`, with `include: []`, so an inherited `noCheck` or `exclude` cannot skip anything. `projectStrictness` records any strict-family options the project turned off, and `noCheck: true`. |
| `infra.json` | Infrastructure classifier verdict and signals. |
| `health.jsonl` | Testnet health probes taken during the run. |
| `isolation.json`, `sandbox.sb`, `sandbox-post.sb` | The self-test results, the agent's sandbox profile and the post-run profile. |
| `score.json` | Rubric scores (after `score`). |

## Ledger checkers

The checkers ([`harness/check.ts`](harness/check.ts)) read validated testnet state over plain JSON-RPC, not xrpl.js, so they never share a bug with the SDK under test. They look at the funded account's MPT issuances, its transaction history and the holders' `MPToken` entries. `result.json` only tells the checker which issuance and holders to look at; every value in it is checked against the ledger. "1,000 of the token" means display units, so the raw amount must be `1000 x 10^AssetScale`.

- **medium:** `result_json`, `issuance_exists`, `requires_approval` (lsfMPTRequireAuth), `holder_authorized`, `holder_balance_1000`, `payment_validated` (the issuer's own validated payments to the holder total exactly 1,000, so a balance topped up by another account does not count), `outstanding_matches`, `readback_matches_ledger`.
- **complex:** `result_json`, `issuance_exists`, `issuance_capabilities` (can-lock, require-auth, can-clawback), `holder_a_state` (500, authorized, not locked), `holder_a_freeze_cycle`, `holder_b_state` (700, authorized, locked), `holder_b_sent_1000`, `holder_b_clawback_300`, `holder_c_banned` (zero balance, not authorized), `holder_c_received_before_ban`, `global_freeze_cycle`, `not_globally_frozen`, `outstanding_consistent`.

A run passes when every criterion passes.

**Infrastructure failures** ([`harness/infra.ts`](harness/infra.ts)) need independent evidence before a run counts as one. The classifier scans only the output of shell commands the agent ran, not files it read or edited, so an agent's own source code cannot trip it:

- Preflight funding or the testnet snapshot failed: infra, re-run.
- The checker itself could not reach testnet: `check_retry`. Re-run `check`, not the agent.
- A failed run whose agent CLI reported a provider usage limit, rate limit or overload: infra, re-run.
- A failed run with a faucet error within 300 characters of a faucet reference in command output: infra, re-run. Faucet limits never count against an agent.
- A failed run where the health monitor saw an outage (two or more consecutive failed probes) *and* the tool output shows rippled connectivity errors: infra, re-run.
- Connectivity errors while the monitor saw testnet healthy count as an agent failure, and the run is marked `suspect` for a human look.

Passing runs are never infra. A re-run happens at most twice.

## Rubric and scoring

The rubric ([`rubric/rubric.json`](rubric/rubric.json)) is a fixed list of choice questions. It covers hallucinated APIs (in the final code and during the run), deprecated patterns, strict-mode type errors, type-system escape hatches, missing outcome checks, waiting for validation, ledger read-back, MPT amount shape, seed handling and connection hygiene. The complex tier adds ban, freeze and clawback semantics. Each item names the evidence it needs.

`score` builds one evidence packet per run: the task text, the final code (build output excluded), compiler output, error excerpts from the transcript, the installed `xrpl` version, and that version's changelog, fetched from the `xrpl@<version>` tag on GitHub. Error excerpts come only from commands the agent ran. Commands that read the installed skill or fetch URLs are left out, since their output is reference text that would reveal the arm. The packet never carries the arm, the agent or the run id. It is scrubbed of skill paths and the word "skill", and the prompt (which differs by arm) is left out. Items that share an evidence set go to Jev in one request, with the key sent only as a header. An answer with confidence of 0.6 or more is final. The rest go to a blind model scorer: Claude Code (`--model opus`, override with `XRPL_EVAL_SCORER_MODEL`) with no tools, a fixed judging system prompt and a JSON schema for the answers. `--calibrate` sends every item to both scorers so `agreement` can report how often they agree.

**Jev's input limit** was measured on 2026-09-28 by sending growing states:

| State size (chars) | Input tokens | Result |
| --- | --- | --- |
| 40,000 | 10,647 | 200, confidence 0.84 |
| 50,000 | 13,208 | 200, confidence 0.21 |
| 120,000 | 31,321 | 200, confidence 0.20 |
| 125,000 | 32,566 | 200, confidence 0.60 |
| 130,000 | n/a | 400 `max_tokens_exceeded` |

The hard limit is therefore about 32.7k input tokens. On that needle-style probe, confidence fell off well before the limit. The scorer sizes each request to 24k tokens at 3 characters per token, and it truncates the largest code file first. If Jev still returns `max_tokens_exceeded`, the scorer shrinks the packet and retries, dropping whole files once trimming is not enough. A shrink applies only to that group's retry, and every group starts from the full packet. `score.json` is written after every request, so a failure part-way keeps the answers already paid for. Failed requests are listed under `jev.errors` and `modelScorer.errors`.

## Budget gate

`set` reads `quota-axi --json` for each provider the set draws on: the Claude `seven_day` window, and Codex's `weekly` window. It then takes the per-run estimates from [`budget/estimates.json`](budget/estimates.json), as a percentage of the weekly allowance. The Claude side counts the agent runs for Opus and Sonnet (they share one allowance) and the blind model scorer for every agent. A set starts only if, for every provider it uses, the check below holds; otherwise the gate refuses it.

```
remaining - reserved by running sets - 1.25 x (runs x per-run estimate + scoring) >= 40%
```

A `WARN` line prints when the current or projected level is at or below 55%. Running sets hold a reservation under `results/.reservations/` until they finish, one file per invocation. Gate and reserve run under a cross-process lock, so two `set` processes started together cannot both pass against the same remaining allowance. A set with no estimate is refused until the calibration pass fills `estimates.json`, or until `--estimate-pct` is passed. Each run records its quota before and after, and its token usage (plus list-price `costUsd` for Claude), as the raw data for calibration. quota-axi reports whole percentages, so one cheap run often moves nothing: each medium Sonnet smoke attempt read the same percentage before and after, while using $0.70 to $0.81 of tokens at list price. Estimate from the delta across a batch of runs, or from a percent-per-dollar ratio measured that way, rather than from single-run deltas.

## Files

- `tasks/`: `medium.md`, `complex.md`, `research-preamble.md` and `environment.md`.
- `rubric/rubric.json`: the rubric.
- `budget/estimates.json`: per-run cost estimates for the gate.
- `harness/`: `cli.ts` is the entry point. The other modules are `run.ts` (one run), `agents.ts`, `sandbox.ts`, `credentials.ts`, `check.ts`, `infra.ts`, `score.ts`, `budget.ts`, `typecheck.ts`, `redact.ts` and `xrpl-rpc.ts`. `harness.test.ts` holds the unit tests.
- `findings/harness-build.md`: friction found while building the harness, for the report.
- `results/`: one directory per run.
