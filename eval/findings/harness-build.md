# Findings from building the harness

This is friction hit while building the harness, before any graded runs. The report task should fold these in next to the results from the grid. Versions: Claude Code 2.1.281, Codex CLI 0.158.0, xrpl 5.3.0, rippled 3.4.1 on testnet, upstream skill commit `eb450f5`.

## Skill installation

**Codex does not load the skill where the official installer puts it.** Codex 0.158 discovers skills in these four places, verified with `codex debug prompt-input` against a probe skill in each candidate location:

- the project's `.agents/skills/`
- the project's `.codex/skills/`
- `$CODEX_HOME/skills/`
- `~/.agents/skills/`

It does not read `.claude/skills/` in the project, or `~/.codex/skills/` when `CODEX_HOME` points elsewhere. Upstream's `install.sh` targets Claude Code only: `~/.claude/skills/xrpl-dev` by default, or `.claude/skills/xrpl-dev` with `--project`. So a Codex user who follows the README gets a skill Codex never sees. The harness works around this with `install.sh --path .agents/skills/xrpl-dev`. `.agents/skills/` is the cross-agent location and the natural default for a second installer target. Codex listed the skill without complaint, including its `user-invocable: true` frontmatter key.

**The README's install URLs use a stale repository name.** Both the quick install (`npx skills add https://github.com/xrpl-commons/xrpl-dev-skill`) and the manual clone name `xrpl-dev-skill`, singular, but the repository is `xrpl-dev-skills`. Both work today only because GitHub redirects the old name.

## SDK

**The `xrpl` npm package ships no changelog.** `xrpl@5.3.0` on npm contains `build/`, `dist/`, `src/`, `README.md` and `LICENSE`, but no `HISTORY.md`. The research preamble tells agents to read the changelog, so they have to find `packages/xrpl/HISTORY.md` in the XRPLF/xrpl.js monorepo on GitHub. The harness fetches it from the `xrpl@<version>` tag for scoring. That changelog carries breaking changes an agent needs:

- 5.0.0: `Wallet.fromSeed` now infers the algorithm from the seed prefix, and `Client.connect()` throws without `network_id`. 5.1.0 reverted the `connect()` part.
- 5.2.0: `Wallet.fromEntropy` input rules changed.

Shipping `HISTORY.md` in the package would put that information in `node_modules`, where agents already look.

**xrpl 5.3.0 pulls in a low-adoption crypto package.** Socket flagged `@xrplf/mpt-crypto` as low-adoption; it comes in transitively through the released `xrpl@5.3.0` (see the smoke run's `final/package-lock.json`).

**`submitAndWait` resolves on a validated failure.** In xrpl 5.3.0 (`src/client/index.ts`, `src/sugar/submit.ts`), `submitAndWait` throws only when the preliminary result is `tem*`. A transaction validated with a `tec*` code (such as `tecNO_AUTH` on an unauthorized MPT holder) comes back as a normal response. Code that awaits `submitAndWait` without reading `meta.TransactionResult` treats a failed MPT authorize, payment or clawback as done. There were three smoke attempts of the same configuration (Sonnet, medium, bare). All three used `submitAndWait`, and the second never checked the result (rubric item `outcome_checks`).

**TypeScript 7 forces a toolchain detour.** `npm install -D typescript` now installs 7.0.2. It hit all three smoke attempts:

- `ts-node` does not work with TypeScript 7. The first attempt pinned `typescript@5.9.3`; the second dropped `ts-node` and compiled with `tsc`.
- TypeScript 7 rejects `moduleResolution: "node"`, so the third attempt rewrote its tsconfig.

Neither xrpl.js nor the skill says which TypeScript toolchain works.

**Agents hardcode the seed they are given.** All three smoke attempts wrote the issuer seed into `src/index.ts` (rubric item `secret_handling`).

## Environment facts the prompts rely on

- The testnet faucet returns ed25519 seeds (`sEd…`), funded with 100 XRP. Reserves are 1 XRP base and 0.2 XRP per owned object.
- MPTokensV1, Clawback, fixMPTDeliveredAmount, TokenEscrow, Credentials and PermissionedDomains are enabled on testnet. DynamicMPT and Batch are not. Each run records the full amendment list in `run.json` under `network.enabledAmendments`.

## Harness-side limits worth knowing

- **Jev's per-request input limit** is about 32.7k tokens (`max_tokens_exceeded` above it). On a needle-style probe, confidence was already low from about 13k tokens. The scorer sends focused packets of at most about 24k tokens, and the 0.6 confidence floor routes weak answers to the model scorer.
- **A fresh `CLAUDE_CONFIG_DIR` has no login,** because Claude Code stores credentials in the macOS keychain. Copying the current OAuth access token into `.credentials.json` in the new config dir works, and needs no new operator login. The harness strips the refresh token so a run can never rotate it; the price is that a run must start with at least its time cap plus 20 minutes left on the token (about 8 hours of life).
- **Sandbox side effects:** a Seatbelt deny turns a missing path into `EPERM` rather than `ENOENT`, and node tooling does not expect that. Two consequences, both fixed and both covered by the pre-run self-test:
  - node's `realpath` needs `lstat` on every ancestor of the workspace, or `node file.js` fails while `node -e` works;
  - npm puts `/private/tmp/node_modules/.bin` on its `PATH`, and the `EPERM` stops the `PATH` search, so `npx` and `npm exec` exit 255 with no message.

  The first smoke attempt caught the `npx` failure; the agent worked around it by calling `node node_modules/typescript/bin/tsc`. That attempt was discarded, and the committed smoke run used the final profile. Direct writes to `/tmp` stay denied on purpose (see the README) and show up as `sandboxDenials` in `infra.json`. Two of three attempts started by redirecting `npm install` output to `/tmp/npm_install.log`, and both recovered on the next command.

## Defects found during the grid run

- **Clarifying questions mid-message went unanswered.** The first detector only looked at the last line of the final message. `complex__codex__research__r2` asked "Should I use native MPT freezes with that exception, or extend the design…?" and then added a closing paragraph, so it never got the fixed reply and stopped without code. Now any question in the final message's prose counts, with code and URLs ignored. The caller still replies only while `result.json` is missing, so an offer made after finishing does not count. Every affected run was re-run; the originals are kept as `…__qdefect1`.
- **Binary result files skipped seed redaction.** Text-only redaction left holder seeds in a Codex run's SQLite store (`final/.private/demo.sqlite`). Binary files are now masked byte for byte. V8's `node-compile-cache`, which one run wrote into the project, is no longer captured.

- **The sandbox broke zsh here-documents.** zsh writes heredoc temp files under `TMPPREFIX` (default `/tmp/zsh`), not `TMPDIR`, and the profile denies `/tmp`. Every `cat <<EOF` in an agent's shell failed with "can't create temp file for here document". It hit 44 of the first 60 runs: all 20 Opus, 18 of 20 Codex and 6 of 20 Sonnet. Agents recovered, usually after one or two failed commands, and pass/fail did not track it (4 of the 8 failures had it). It still skewed time and error-recovery comparisons between agents. `TMPPREFIX` now points into the run's `tmp/`, and the self-test checks zsh and bash heredocs. The 44 affected runs were re-run; the originals are kept unscored as `…__tmpdefect1`.

## Agent behaviour worth knowing (not harness defects)

- **Headless Claude Code kills background tasks at the end of a turn.** Three Sonnet complex runs (`research__r1`, `skill-research__r1`, `skill-research__r3`) started their testnet demo with `run_in_background`, then ended the turn to wait for it ("I'll wait for the background demo run to complete rather than poll it."). Under `claude -p`, nothing wakes the session again: the CLI marked the task `killed` and exited, leaving a half-run demo and no `result.json`. These are scored as agent failures, since that is what an unattended user of `claude -p` would get. The agent asked no question, so the fixed clarify reply does not apply. Opus and Codex never did this.
- **Gate reservations carry no margin.** A running set's reservation holds its raw estimate, while the set being gated is charged 1.25x. So a later set in the same `set --sets` invocation projects slightly higher than a strict reading of the rule would. Across this grid it never changed a decision; the smallest projection was 45% against a 40% floor.
