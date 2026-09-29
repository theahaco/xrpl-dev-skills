# Making AI agents good at XRPL: an evaluation of the xrpl-dev skill

*A 60-run test of three coding agents building MPT issuers with xrpl.js, with and without the official skill, and proposals for the skill, xrpl.js and the agent tooling around them*

We gave three AI coding agents the same two XRP Ledger jobs, over and over: issue a Multi-Purpose Token (MPT) and pay a holder, and build a compliance-grade MPT issuer with clawback, bans, per-holder freeze and global freeze. Each run was one-shot and unattended, in strict TypeScript on the released `xrpl` package, against testnet. Half the runs had the official [xrpl-dev skill](https://github.com/XRPL-Commons/xrpl-dev-skills) installed; half were told to research the current versions of everything first. An automated checker read the resulting ledger state, and a blind rubric scored the code.

Wherever an agent got stuck, left the ledger wrong or wrote something a reviewer would reject, we traced it to an owner: the skill, xrpl.js, or the agent tooling around them. This document collects what we found and what we propose. None of theahaco's SDK forks were used; this tests the ecosystem as a developer finds it today.

> **Draft, not yet published.** ⚠️ marks every number that includes Sonnet 5 on the complex tier. 7 of its 12 runs are final; 5 re-runs are still running after a harness defect (Part 5). Those numbers will change.

| | |
| --- | --- |
| **Harness** | [PR #1](https://github.com/theahaco/xrpl-dev-skills/pull/1) (merged): the runner, sandbox, ledger checkers and rubric scorer under `eval/` |
| **Raw results** | branch [`fm/xrpl-ai-eval-runs-e2`](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results): one directory per run with the transcript, final code, ledger check and scores, plus [harness-build findings](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/findings/harness-build.md) |
| **Proposed skill changes** | this PR: new [`skill/mpt.md`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-report-e3/skill/mpt.md), and edits to `client-sdk.md`, `tokens.md`, `SKILL.md`, `security.md`, `resources.md`, `install.sh` and `README.md` |
| **Earlier audits** | xrpl.js [#64](https://github.com/theahaco/xrpl.js/issues/64), xrpl-rust [#53](https://github.com/theahaco/xrpl-rust/issues/53) and [#45](https://github.com/theahaco/xrpl-rust/issues/45), xrpl-dev-portal [#2](https://github.com/theahaco/xrpl-dev-portal/issues/2) |

---

## At a glance

- **Agents finish the job.** 51 of 55 final runs ⚠️ left testnet in exactly the requested state. Opus 5.5 and Codex passed all 40 of theirs. Every failure so far is Sonnet 5 on the complex tier ⚠️, and two of those four never finished because the CLI killed their demo.
- **The skill and the research preamble barely change the outcome.** Ledger pass rates are flat across the four arms, and so are 11 of the 14 rubric items. The research preamble made agents do the research (28 of 28 read the xrpl changelog) and kept their toolchain current, but it cost up to twice the time and removed none of the errors below.
- **The hard part is xrpl.js's TypeScript types, not the protocol.** 47 of 55 runs ⚠️ hit compiler errors on MPT ledger or metadata types. 26 tried `import { MPToken } from 'xrpl'`, and 33 final projects ⚠️ cast `ledger_entry` results with `as unknown as`. Every one of these problems is already in the [xrpl.js audit](https://github.com/theahaco/xrpl.js/issues/64). The compiler caught all of them, and no final project used a non-existent API or failed strict mode.
- **The skill's own MPT example teaches the mistakes we saw.** Submitted as written, it throws a validation error. It sets `AssetScale: 2` and then pays `value: "50"` without saying the value is in raw units. Of the 8 attempts that set an `AssetScale`, 6 were in skill arms, and 4 of the 8 sent amounts 100 times too small.
- **The skill reaches some agents and not others.** The official installer only writes to `.claude/skills`, which Codex never reads. Opus ignored the installed skill in 3 of 10 runs. Sonnet loaded it every time, and still wrote the issuer's seed into source in 13 of 15 runs ⚠️, with or without the skill; Opus and Codex never did.
- **Our proposal:**
  - replace the skill's MPT sketch with a tested playbook (issue, approve, pay in raw units, read back without casts, lock, claw back, ban), fix the examples that don't compile or don't validate, and add an installer target for Codex (this PR);
  - ship the MPT type fixes the xrpl.js audit already proposes, plus three small new ones;
  - close three tooling gaps: no changelog in the npm package, no guidance for TypeScript 7, and headless Claude Code killing work still running at the end of a turn.

---

## Part 1: Where agents get stuck

Each finding names an owner: **skill**, **xrpl.js**, or **tooling** (agent CLIs, npm packaging, TypeScript). Where the xrpl.js audit ([#64](https://github.com/theahaco/xrpl.js/issues/64)) already covers a problem, we link its finding instead of restating it. Counts are over the 55 final runs unless a line says otherwise.

### 1. Reading MPT state back in strict TypeScript (xrpl.js)

Both tasks end by reading balances back from the ledger. In xrpl 5.3.0 that means `ledger_entry`, whose response is typed as the whole `LedgerEntry` union. `MPTokenIssuance` narrows on `LedgerEntryType`, but `MPToken` isn't in the union at all, so narrowing to it gives `never`:

```
TS2339: Property 'MPTAmount' does not exist on type 'never'.
TS2352: Conversion of type 'LedgerEntry' to type 'MPToken' may be a mistake because neither type sufficiently overlaps with the other.
```

- **Every agent hit it, in every arm.** 26 of 55 runs ⚠️ got one of these two errors ([Codex, medium](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/medium__codex__skill__r2/transcript/agent.jsonl#L29)).
- **The way out is a double cast.** 33 of 55 final projects ⚠️ contain `as unknown as`, almost always on `response.result.node`: Opus ([`ledger.ts:95`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-opus__skill__r3/final/src/ledger.ts#L95)), Codex ([`issuer.ts:94`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__codex__bare__r3/final/src/issuer.ts#L94)) and Sonnet ([`index.ts:44`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/medium__claude-sonnet__bare__r2/final/src/index.ts#L44)) alike. The rubric counts these as escape hatches; Codex ended "pervasive" in 10 of its 12 complex runs.
- **The type is also wrong.** Two agents found at runtime that `MPTAmount` is missing when a balance is zero, although the type marks it required ([Codex](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__codex__skill__r1/transcript/agent.jsonl#L42), [Sonnet](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r2/transcript/final-message.md) ⚠️).

The xrpl.js audit already has all of this: [005](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/005-ledger-entry-response-never-narrows-node.md) (`ledger_entry` never narrows), [006](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/006-mptoken-missing-from-ledgerentry-union.md) (`MPToken` missing from the union), [010](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/010-mptoken-ledger-type-mismatches-rippled-json.md) (`MPTAmount` wrongly required) and [083](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/083-fetchmptoken-helpers-exist-but-hidden-in-confidential-module.md) (the SDK's own read helpers exist, hidden, and use the same cast). What these runs add is a measurement: this is where agents most often stall. Until xrpl.js ships the fix, the skill now shows a runtime guard that type-checks without a cast.

### 2. Names that exist, just not where agents look (xrpl.js)

The rubric flagged 42 of 55 runs ⚠️ for trying an API that doesn't exist during the run. Read the compiler output, and most of them are real xrpl.js names imported from the wrong place:

| What the agent wrote | Runs | What xrpl 5.3.0 has |
| --- | --- | --- |
| `import { MPToken, MPTokenIssuance } from 'xrpl'` | 26 ⚠️ | `LedgerEntry.MPToken` and `LedgerEntry.MPTokenIssuance`, in a namespace |
| `import { MPTokenIssuanceFlags } from 'xrpl'` | 10 ⚠️ | `LedgerEntry.MPTokenIssuanceFlags` (ledger flags) or `MPTokenIssuanceCreateFlags` (transaction flags). The compiler suggests `MPTokenIssuanceSetFlags`, a third thing ([Opus](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-opus__research__r1/transcript/agent.jsonl#L522)) |
| `import { MPTokenIssuanceCreateMetadata } from 'xrpl'`, or `meta.mpt_issuance_id` on an untyped response | 7 ⚠️ | declared in the package, but not exported |
| a helper typed `(tx: Transaction)`, passed to `submitAndWait` | 14 (all Codex) | `submitAndWait` takes `SubmittableTransaction` ([Codex](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__codex__skill__r2/transcript/agent.jsonl#L27)) |

The compiler caught every one of these: final code used a non-existent API in 0 of 55 runs and failed strict mode in 0 of 55. The cost is the time spent, and the casts from finding 1.

The namespace problem is xrpl.js audit [031](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/031-ledger-entry-types-namespaced-undiscoverable.md). The unexported `MPTokenIssuanceCreateMetadata` is new. `SubmittableTransaction` exists for a good reason, since pseudo-transactions can't be submitted, but `Transaction` is the name agents reach for, and nothing on either type points to the other.

### 3. Display units versus raw units (skill, xrpl.js)

"Send the holder 1,000 of the token" means 1,000 display units, so with `AssetScale: 2` the raw amount on the ledger must be `100000`. Agents that chose a scale often got this wrong:

- **8 of 100 attempts set an `AssetScale`** (the 55 final runs plus 45 superseded ones, which were set aside for an unrelated shell defect but are real agent behaviour). **4 of the 8 sent unscaled amounts** and failed the ledger check:
  - [complex, Sonnet, skill](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r2/check.json) ⚠️: "balance 500 raw (scale 2); expected … 50000 raw";
  - [complex, Sonnet, research](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__research__r2/check.json) ⚠️: the same;
  - two superseded Sonnet skill-arm attempts ([medium](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/medium__claude-sonnet__skill__r1__tmpdefect1/check.json), [complex](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r3__tmpdefect1/check.json)).

  Both final runs then told the user that A holds 500 ([one](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r2/transcript/final-message.md) ⚠️), reading raw units as display units.
- **6 of the 8 were in skill arms.** The skill's only MPT example sets `AssetScale: 2, // decimal places` and then pays `value: "50"`, with no word on which unit `value` is in ([`tokens.md` L108-L117 and L139-L150](https://github.com/XRPL-Commons/xrpl-dev-skills/blob/eb450f5a4575e48ca196ed0daad72420d4db6d91/skill/tokens.md#L108-L150)). Sonnet read that file ([transcript](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r2/transcript/agent.jsonl#L11)) ⚠️ before writing `DEFAULT_ASSET_SCALE = 2` ([`constants.ts:12`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r2/final/src/constants.ts#L12)) and `send(…, "1000")` ([`demo.ts:116`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r2/final/demo.ts#L116)).
- **The rubric missed both final failures.** Its amount-format item passed them. Only the ledger checker, which reads the raw amounts, caught the problem (see Part 6).

On the xrpl.js side this is audit findings [045](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/045-assetscale-docs-contradictory.md) (the two `AssetScale` doc comments contradict each other and name no unit) and [016](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/016-mpt-amount-value-not-validated-no-scale-helper.md) (no `xrpToDrops` equivalent for MPTs). The skill's part is the example, which the new `mpt.md` replaces with a units section, a `toRawUnits` helper and a default of `AssetScale: 0`.

### 4. The skill's MPT guidance is a sketch, and parts of it are wrong (skill)

The skill at the tested commit ([`eb450f5`](https://github.com/XRPL-Commons/xrpl-dev-skills/tree/eb450f5a4575e48ca196ed0daad72420d4db6d91/skill), still upstream `main`) covers MPTs in three short snippets. It says nothing about capability flags, where the issuance ID comes from, reading balances back, locking, clawback, revoking approval or bans, which is everything the complex task needs. What it does say has problems:

- **The create example doesn't validate.** Submitted verbatim with xrpl 5.3.0, it throws `ValidationError: MPTokenIssuanceCreate: TransferFee cannot be provided without enabling tfMPTCanTransfer flag` ([`tokens.md` L111-L117](https://github.com/XRPL-Commons/xrpl-dev-skills/blob/eb450f5a4575e48ca196ed0daad72420d4db6d91/skill/tokens.md#L111-L117)).
- **The outcome-check example doesn't compile in strict mode.** `result.result.meta.TransactionResult` fails with `TS18048` and `TS2339`, because `meta` is typed `TransactionMetadata | string | undefined` ([`client-sdk.md` L120-L125](https://github.com/XRPL-Commons/xrpl-dev-skills/blob/eb450f5a4575e48ca196ed0daad72420d4db6d91/skill/client-sdk.md#L120-L125)).
- **Reserve figures contradict each other.** `SKILL.md` says a 10 XRP base reserve and 2 XRP per object; `client-sdk.md` says 1 and 0.2; `tokens.md` says 2 XRP per trust line and per MPT. Testnet reported 1 and 0.2 in every run.
- **The only freeze guidance is for trust lines** (`TrustSet` flags and `AccountSet` `asfGlobalFreeze`), which don't apply to MPTs.

So agents looked elsewhere. 52 of 55 runs ⚠️ read the installed package's type declarations or source. Skill-arm agents typically grepped the skill for "mpt" ([Opus](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-opus__skill__r1/transcript/agent.jsonl#L26)) and went straight to `node_modules/xrpl`. They still got the protocol right (see finding 10), from xrpl.org and the types rather than the skill.

One protocol detail the skill should carry is how narrow an MPT lock is. We checked on testnet (rippled 3.4.1): a lock blocks payments between holders (`tecLOCKED`), but the issuer can still pay a locked holder, the locked holder can still pay the issuer, and clawback still works. So a lock doesn't match a requirement like "can't send or receive". Codex found and reported this in 12 of 12 complex runs ("native MPT freezes still permit redemption to the issuer", [transcript](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__codex__skill__r1/transcript/agent.jsonl#L17)), Opus in 11 of 12, and Sonnet in 2 of 7 ⚠️, mostly by reading the rippled source or xrpl.org.

### 5. Seeds end up in source files (agent behaviour, skill example)

Each prompt handed the agent a testnet seed for the issuer account.

- **Sonnet 5 wrote it into a source file in 13 of 15 runs** ⚠️: 8 of 8 medium, 5 of 7 complex ⚠️ ([`index.ts:12`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/medium__claude-sonnet__skill__r1/final/src/index.ts#L12)). Opus and Codex did it in 0 of 40; they used `.env` or git-ignored state files.
- **The skill didn't change this.** Sonnet hardcoded the seed in 5 of 6 skill-arm runs ⚠️ and 8 of 9 others ⚠️, although it loaded the skill every time. The skill's security page says to use environment variables, but its own wallet example is `Wallet.fromSeed('sEdT...')` ([`client-sdk.md` L40](https://github.com/XRPL-Commons/xrpl-dev-skills/blob/eb450f5a4575e48ca196ed0daad72420d4db6d91/skill/client-sdk.md#L40)).
- **One variant looks safe and isn't:** `process.env.ISSUER_SEED ?? '<the seed>'` ([`demo.ts:7`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__research__r2/final/demo/demo.ts#L7) ⚠️). The rubric scorer passed it; our counts use a direct check for the seed in `.ts` and `.js` files.

The new examples read the seed through a `requireEnv` helper, and the rules say explicitly that a seed pasted into the prompt, or used as a fallback default, still counts.

### 6. The skill reaches some agents and not others (skill installer, tooling)

- **Codex never sees the skill as installed by the README.** `install.sh` writes to `~/.claude/skills/xrpl-dev`, or `.claude/skills/xrpl-dev` with `--project`. Codex 0.158 reads `.agents/skills`, `.codex/skills`, `$CODEX_HOME/skills` and `~/.agents/skills`, never `.claude/skills` ([harness findings](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/findings/harness-build.md#skill-installation)). To test the content anyway, the harness installed it with `--path .agents/skills/xrpl-dev`, so the Codex skill arms measure a setup no Codex user following the README has today. Installed there, Codex read `SKILL.md` in 10 of 10 skill-arm runs and a topic file in 9.
- **Opus often skips it.** In 3 of 10 skill-arm runs Opus never opened the skill's content ([one example](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-opus__skill__r2): 30 shell commands, none touching the skill). In 5 it invoked the skill, and in 2 it grepped the files for "mpt". Sonnet invoked it in all 6 skill-arm runs ⚠️.
- **The description doesn't name what these tasks asked for.** It lists "tokens" but not MPTs, freezes or clawback. We've added them; whether that changes Opus's uptake is a question for the re-run.
- **The README points at a stale repository name.** Both install commands use `xrpl-commons/xrpl-dev-skill` (singular), which works only through GitHub's redirect, and the README describes xrpl.js as v4.x.

### 7. TypeScript 7 changed the toolchain under everyone (tooling)

`npm install -D typescript` now installs 7.0.2, and most agents configured a project the way TypeScript 5 expected.

- **18 of 55 runs ⚠️ hit TypeScript 7 configuration errors.** Sonnet got `TS5108: Option 'moduleResolution=node10' has been removed` in 11 of 15 runs ⚠️ ([transcript](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__bare__r3/transcript/agent.jsonl#L358)); Codex got `TS5011` (explicit `rootDir` required) in 7 of 20.
- **7 runs fell back to TypeScript 5.x,** all in arms without the research preamble. The harness smoke runs also found `ts-node` doesn't work with TypeScript 7.
- **Nothing tells agents which toolchain works:** not xrpl.js, not the skill. The skill now has a known-good `tsconfig.json` and the three TypeScript 7 changes that bit.

### 8. Finding the current version and its changelog (tooling, skill)

- **The npm package ships no changelog.** `xrpl@5.3.0` has no `HISTORY.md`; it lives in the XRPLF/xrpl.js monorepo. With the research preamble, agents found it anyway (28 of 28), mostly on `main` rather than at the `xrpl@5.3.0` tag they had installed. Some looked in `node_modules/xrpl` first ([Sonnet](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__research__r3/transcript/agent.jsonl#L110) ⚠️) or guessed `CHANGELOG.md` ([Sonnet](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/medium__claude-sonnet__skill-research__r2/transcript/agent.jsonl#L29)).
- **Without the preamble, agents rarely looked** (1 of 27). Two skill-only runs wrote the version range into `package.json` from memory and got the old major: `"xrpl": "^4.6.0"` ([Codex](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__codex__skill__r1/final/package.json)) and `"^4.1.0"` ([Sonnet](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/medium__claude-sonnet__skill__r1/final/package.json)), which both installed 4.6.0. They passed, on a release line with a different `Wallet.fromSeed` default. The skill names no version. The research-arm runs installed 5.3.0 and TypeScript 7 in 28 of 28.

### 9. Headless agents end the turn with work still running (tooling)

Two of the four Sonnet complex failures ⚠️ had correct code and never finished their demo:

- [complex, research, r1](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__research__r1/transcript/final-message.md) ⚠️ started the demo with `run_in_background`, scheduled a wake-up, and ended its turn: "I'll report back with results as soon as one of those completes".
- [complex, skill + research, r1](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill-research__r1/transcript/agent.jsonl#L451) ⚠️ ran the demo in the foreground with a 300 s timeout. Claude Code moved it to the background ("You will be notified when it completes"), and the agent ended its turn: "I'll wait for the background demo run to complete rather than poll it" ([L468](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill-research__r1/transcript/agent.jsonl#L468)).

Under `claude -p` nothing wakes the session again, so the CLI killed both demos and exited. [Opus](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-opus__skill__r1) also backgrounded its demo once, then waited on it in a foreground loop and passed. This is the CLI's behaviour more than the model's: a headless session promises a notification it can never deliver. The skill now tells agents to run ledger-changing scripts in the foreground with a timeout long enough for every transaction to validate.

### 10. What agents got right

- **Submitted is not succeeded.** In all 55 final runs ⚠️, the agent waited for every transaction to validate and checked its result. `submitAndWait` resolves on a validated `tec*` failure, so each agent wrote that check by hand ([#64](https://github.com/theahaco/xrpl.js/issues/64) Part 1 §2; findings [025](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/025-submitandwait-three-failure-surfaces-no-result-helper.md), [043](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/043-submitandwait-throws-doc-claims-tec-rejects.md), [001](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/001-submitandwait-meta-string-undefined.md)). The skill's own example of the check doesn't compile (finding 4).
- **MPT semantics.** Every complex run ⚠️ locked with `MPTokenIssuanceSet` (with `Holder` for one holder, without for all), clawed back with a `Holder`, and banned by clawback plus revoking approval. None used trust-line freeze flags on an MPT.
- **Current APIs.** No final project used a deprecated xrpl.js pattern.
- **Honest reporting.** Most Opus and Codex runs told the user where the ledger falls short of the spec (finding 4) instead of claiming it all worked.

---

## Part 2: What we propose

### For the official skill (this PR)

Every change traces to a finding above. Every TypeScript block in the new and edited files compiles against `xrpl@5.3.0` with TypeScript 7 in strict mode (also with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`), and the `mpt.md` flow ran end to end on testnet, ending in the state the complex task asks for.

| Change | Findings | Files |
| --- | --- | --- |
| **New MPT playbook.** Capability flags; raw amounts with a `toRawUnits` helper and an `AssetScale: 0` default; create and read the issuance ID from typed metadata; holder opt-in then issuer approval; payments; read-back through a runtime guard instead of `as unknown as`; what a lock does and doesn't block (tested); clawback; the ban recipe and why its order matters; the xrpl.js 5.x names that tripped agents; anti-patterns | 1, 2, 3, 4 | [`skill/mpt.md`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-report-e3/skill/mpt.md) (new) |
| Replace the MPT sketch with a summary, a create example that validates, and a pointer to `mpt.md`; correct reserves; label the freeze section as trust-line only | 3, 4 | `skill/tokens.md` |
| Project setup: install the current `xrpl`, a TypeScript 7 `tsconfig.json`, `tsx` instead of `ts-node`, where the changelog is. A `submitOrThrow` helper that compiles in strict mode. Seeds through `requireEnv` | 4, 5, 7, 8 | `skill/client-sdk.md` |
| Description names MPT compliance controls; correct reserves; `submitAndWait` resolves on `tec*`; a secrets rule; type-check first; run ledger scripts in the foreground with a long enough timeout; link `mpt.md` | 4, 5, 6, 9 | `skill/SKILL.md` |
| Seeds from the prompt and `??` fallbacks; an MPT controls section, including the lowercase `holder` trap from xrpl.js audit [061](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/061-lowercase-field-names-silently-dropped-when-signing.md), which we re-checked on 5.3.0 | 4, 5 | `skill/security.md` |
| MPT concepts, known amendments, the `feature` method, the xrpl.js changelog | 8 | `skill/resources.md` |
| `--agents` installs to `~/.agents/skills` (or `.agents/skills` with `--project`) for Codex and other agents; the Claude default is unchanged | 6 | `install.sh` |
| Repository URLs, xrpl.js 5.x, install instructions for Codex, `mpt.md` in the file list | 6 | `README.md` |

Nothing here goes to XRPL-Commons without explicit approval.

### For xrpl.js

Most of what the agents hit is already proposed in the [xrpl.js audit](https://github.com/theahaco/xrpl.js/issues/64); these runs are more evidence for it. The last three rows are new and could join that audit's register. No change to any SDK repository is part of this work.

| Problem | Evidence here | Where it's covered |
| --- | --- | --- |
| `MPToken` missing from `LedgerEntry`; `ledger_entry` never narrows `node` | finding 1: 26 runs ⚠️, 33 projects cast ⚠️ | [005](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/005-ledger-entry-response-never-narrows-node.md), [006](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/006-mptoken-missing-from-ledgerentry-union.md); #64 "Types that carry through" |
| Ledger entry types reachable only as `LedgerEntry.*` | finding 2: 26 runs ⚠️ | [031](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/031-ledger-entry-types-namespaced-undiscoverable.md) |
| `MPTAmount` required in the type, omitted by rippled at zero | finding 1 | [010](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/010-mptoken-ledger-type-mismatches-rippled-json.md) |
| Typed MPT read helpers exist but are hidden | finding 1 | [083](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/083-fetchmptoken-helpers-exist-but-hidden-in-confidential-module.md) |
| `AssetScale` docs contradict; no display-to-raw helper | finding 3: 4 of 8 scaled attempts wrong | [045](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/045-assetscale-docs-contradictory.md), [016](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/016-mpt-amount-value-not-validated-no-scale-helper.md); #64 "MPT workflows" |
| `submitAndWait` resolves on `tec*`; `meta` typed as possibly a string | finding 10: every agent hand-wrote the check | [025](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/025-submitandwait-three-failure-surfaces-no-result-helper.md), [043](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/043-submitandwait-throws-doc-claims-tec-rejects.md), [001](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/001-submitandwait-meta-string-undefined.md); #64 "Validated success or throw" |
| A lowercase `holder` is dropped at signing, turning a one-holder lock into a global one | not hit here; re-checked on 5.3.0 | [061](https://github.com/theahaco/xrpl.js/blob/fm/xrpljs-mpt-audit-x1/audit/061-lowercase-field-names-silently-dropped-when-signing.md) |
| **New:** `MPTokenIssuanceCreateMetadata` is declared but not exported | finding 2: 7 runs ⚠️ | export it from `models/transactions/index.ts` |
| **New:** the npm package ships no changelog | finding 8 | add `HISTORY.md` to the package's `files` |
| **New:** `Transaction` versus `SubmittableTransaction` is undiscoverable | finding 2: 14 of 20 Codex runs | a TSDoc note on both types and on `submitAndWait` |

### For agent tooling and the ecosystem

- **Skill locations.** `.agents/skills` is the one directory both Codex and a growing set of other agents read. Skill installers should offer it (this PR does for `install.sh`), and README install steps should say which agents each target reaches.
- **Headless Claude Code.** When `claude -p` ends a turn with background tasks still running, it kills them and exits. It should either wait for them or stop promising a notification ("You will be notified when it completes") that can't arrive. Two of the four Sonnet complex failures ⚠️ come from this.
- **TypeScript 7.** Removing `moduleResolution: "node"`, requiring `rootDir`, and dropping `ts-node` compatibility broke 18 of 55 projects ⚠️ on first compile. SDK READMEs and skills that show a `tsconfig.json` should show one that works on TypeScript 7.
- **Changelogs in packages.** Agents look in `node_modules` first. A changelog in the published package costs nothing and would have saved every research-arm run a web lookup.

---

## Part 3: How we tested

Everything below is in the [harness](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/README.md) and its per-run records; this is the summary.

**Tasks.** Two tiers, with the prompts exactly as the agents saw them:

- [medium](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/tasks/medium.md): issue an MPT that only approved holders can hold, approve a second account, pay it 1,000, and read the balances back;
- [complex](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/tasks/complex.md): a reusable, "production quality" issuer module with allow-list, clawback, bans, per-holder freeze and global freeze, plus a demo that drives three holders into a required end state.

Both append an [environment block](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/tasks/environment.md) with a pre-funded testnet account (100 XRP) and its seed.

**Arms.** A 2×2 grid: the official skill installed or not, crossed with a fixed [research preamble](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/tasks/research-preamble.md) or not. The preamble asks the agent to check the latest `xrpl` on npm and its changelog, read xrpl.org for every transaction type it uses, and confirm the amendments enabled on testnet. It names no pitfalls. The skill was upstream `main` at [`eb450f5`](https://github.com/XRPL-Commons/xrpl-dev-skills/tree/eb450f5a4575e48ca196ed0daad72420d4db6d91), installed by upstream's own `install.sh`.

**Agents,** each at its out-of-the-box default model and effort:

| Agent | CLI | Model | Effort |
| --- | --- | --- | --- |
| Opus 5.5 | Claude Code 2.1.281 | `claude-opus-5-5` | default |
| Sonnet 5 | Claude Code 2.1.281 | `claude-sonnet-5` | default |
| Codex | Codex CLI 0.158.0 | `gpt-6-astra` | default (unset in config) |

**Stack.** The agents chose their own versions: `xrpl` 5.3.0 in 53 runs and 4.6.0 in 2 (finding 8); TypeScript 7.0.2 in 48 and 5.x in 7. Node 24.18.0. Testnet ran rippled 3.4.1, with reserves of 1 XRP plus 0.2 XRP per object; `MPTokensV1` and `Clawback` were enabled, `DynamicMPT` was not.

**Repetitions.** 2 per cell on medium and 3 on complex: 24 medium and 36 complex runs, 60 in total. 55 are final. 44 first attempts were re-run after a harness defect and one after a question-detection defect; the originals are kept as evidence (Part 5).

**Isolation.** Each run had a fresh workspace with an empty git repository, a throwaway `HOME`, a fresh `CLAUDE_CONFIG_DIR` or `CODEX_HOME` holding only an access token (no refresh token), and a macOS Seatbelt profile denying reads of the operator's home, the theahaco repositories, the audits and the firstmate fleet. A self-test proved the sandbox before every run ([`isolation.json`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-opus__bare__r1/isolation.json) in each run). Runs were one-shot. The harness would have answered any clarifying question with "Proceed with your best judgment"; no final run needed it. Time caps were 40 minutes (medium) and 90 (complex); none was hit.

**Scoring.**

- **Ledger check** (pass/fail). Per-task checkers read validated testnet state over plain JSON-RPC, not xrpl.js, so they can't share a bug with the SDK under test. Amounts are checked in raw units: "1,000 of the token" must be `1000 × 10^AssetScale`.
- **Rubric.** 14 fixed choice items ([`rubric.json`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/rubric/rubric.json)): non-existent APIs in the final code and during the run, deprecated patterns, strict-mode errors, type escape hatches, outcome checks, waiting for validation, ledger read-back, MPT amount shape, seed handling, connection hygiene, and on complex, ban, freeze and clawback semantics. The evidence packet leaves out the arm, the agent, the run ID, the prompt, and anything read from the skill.
- **Scorers.** [Jev](https://typesafe.ai) (System One, `jev-1.13.0`) scores each item first. An answer at confidence 0.6 or above is final. The rest go to a blind model scorer (Claude Code on Opus 5.5, no tools, fixed judging prompt).
  - **Calibration sample.** 7 runs sent every item to both scorers. They agreed on 80 of 83 items (96.4%).
  - **Low-confidence items.** On the 99 items routed from the other 48 runs, they agreed on 82 (82.8%). This is lower, as expected, since these are the items Jev was unsure of.
  - **Overall.** Jev decided 554 of 667 item scores and the model scorer 113. Jev fell below the floor on the code-heavy `hallucinated_api` item in 47 of those 48 runs, and 13 of 55 code packets had to be truncated to fit Jev's input limit. The model scorer cost $13.10 in total.
- **Process metrics** come from the transcripts: agent time, tokens (list-price cost for Claude; Codex reports none), tool calls, and failed tool calls (a Claude tool error or a non-zero Codex exit, including sandbox denials).

**Budget.** A set (one agent, one tier, every arm and rep) could start only if, after a 25% margin including scoring, the provider's weekly allowance stayed above 40%. The [calibration pass](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/budget/calibration.md) of one complex bare run per agent measured about 1% of the Claude allowance per complex Claude run, and at most 2% of Codex's per complex Codex run.

- **Spend.** Over the grid, the Claude allowance went from 91% to 84% remaining, before the 5 pending re-runs. Codex went from 94% to 60%. At list price, the 35 final Claude runs cost $65.83, and $118.28 including superseded attempts. Agents ran for 9.6 hours (18.2 including superseded attempts).
- **The before/after re-run.** The gate's per-run estimates are deliberately high: the whole grid so far used 7 points of the Claude allowance. Even so, Claude has about 44 points above the floor, enough at those estimates for one complex set per Claude agent before its allowance resets on 3 October. Codex has 20 points above the floor until its reset on 5 October, which the gate converts to at most 8 complex Codex runs. A full Codex complex set is 12, so it has to wait for the reset or be cut down.

---

## Part 4: Results

### Ledger check

Runs that left testnet in exactly the requested state, per cell:

| Tier | Agent | bare | skill | research | skill + research | All arms |
| --- | --- | --- | --- | --- | --- | --- |
| medium | Opus 5.5 | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| medium | Sonnet 5 | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| medium | Codex | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| complex | Opus 5.5 | 3/3 | 3/3 | 3/3 | 3/3 | 12/12 |
| complex | Sonnet 5 ⚠️ | 2/2 ⚠️ (1 pending) | 0/1 ⚠️ (2 pending) | 1/3 ⚠️ | 0/1 ⚠️ (2 pending) | 3/7 ⚠️ |
| complex | Codex | 3/3 | 3/3 | 3/3 | 3/3 | 12/12 |
| **all** | | **14/14** ⚠️ | **12/13** ⚠️ | **13/15** ⚠️ | **12/13** ⚠️ | **51/55** ⚠️ |

The four failures ⚠️:

| Run | Failed criteria | Cause |
| --- | --- | --- |
| [complex, Sonnet, research, r1](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__research__r1) | `result_json` | demo left running in the background at the end of the turn (finding 9) |
| [complex, Sonnet, research, r2](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__research__r2) | A and B balances, B's payment and clawback | `AssetScale: 2` with unscaled amounts (finding 3) |
| [complex, Sonnet, skill, r2](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill__r2) | the same four | the same |
| [complex, Sonnet, skill + research, r1](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__skill-research__r1) | 10 of 13 | demo moved to the background after a 300 s timeout, then the turn ended (finding 9) |

### Rubric

The items that separate cells, per cell. "No non-existent API tried" is the rubric's during-run item. The seed column is our direct check for the seed in a `.ts` or `.js` file (Part 6 explains why).

| Tier | Agent | Arm | No non-existent API tried during run | Escape hatches (none / few / pervasive) | Seed kept out of source | Client closed on error paths |
| --- | --- | --- | --- | --- | --- | --- |
| medium | Opus 5.5 | bare | 1/2 | 2 / 0 / 0 | 2/2 | 2/2 |
| medium | Opus 5.5 | skill | 1/2 | 1 / 1 / 0 | 2/2 | 2/2 |
| medium | Opus 5.5 | research | 0/2 | 2 / 0 / 0 | 2/2 | 2/2 |
| medium | Opus 5.5 | skill + research | 1/2 | 2 / 0 / 0 | 2/2 | 2/2 |
| medium | Sonnet 5 | bare | 0/2 | 0 / 2 / 0 | 0/2 | 2/2 |
| medium | Sonnet 5 | skill | 2/2 | 1 / 1 / 0 | 0/2 | 2/2 |
| medium | Sonnet 5 | research | 0/2 | 0 / 2 / 0 | 0/2 | 2/2 |
| medium | Sonnet 5 | skill + research | 1/2 | 2 / 0 / 0 | 0/2 | 2/2 |
| medium | Codex | bare | 1/2 | 2 / 0 / 0 | 2/2 | 2/2 |
| medium | Codex | skill | 0/2 | 1 / 1 / 0 | 2/2 | 2/2 |
| medium | Codex | research | 0/2 | 1 / 1 / 0 | 2/2 | 2/2 |
| medium | Codex | skill + research | 0/2 | 1 / 1 / 0 | 2/2 | 2/2 |
| complex | Opus 5.5 | bare | 1/3 | 0 / 3 / 0 | 3/3 | 3/3 |
| complex | Opus 5.5 | skill | 0/3 | 0 / 1 / 2 | 3/3 | 2/3† |
| complex | Opus 5.5 | research | 2/3 | 0 / 2 / 1 | 3/3 | 3/3 |
| complex | Opus 5.5 | skill + research | 0/3 | 2 / 1 / 0 | 3/3 | 3/3 |
| complex | Sonnet 5 | bare ⚠️ | 1/2 | 0 / 2 / 0 | 0/2 | 1/2 |
| complex | Sonnet 5 | skill ⚠️ | 0/1 | 1 / 0 / 0 | 1/1 | 1/1 |
| complex | Sonnet 5 | research ⚠️ | 1/3 | 0 / 2 / 1 | 1/3 | 1/3 |
| complex | Sonnet 5 | skill + research ⚠️ | 1/1 | 0 / 1 / 0 | 0/1 | 0/1 |
| complex | Codex | bare | 0/3 | 1 / 0 / 2 | 3/3 | 3/3 |
| complex | Codex | skill | 0/3 | 0 / 1 / 2 | 3/3 | 3/3 |
| complex | Codex | research | 0/3 | 0 / 0 / 3 | 3/3 | 3/3 |
| complex | Codex | skill + research | 0/3 | 0 / 0 / 3 | 3/3 | 3/3 |

† A verified scorer miss: the third run closes its client in a `finally` block (Part 6).

Nine items passed in every run where they apply ⚠️:

- no non-existent API in the final code (55/55);
- no deprecated pattern (55/55);
- clean in strict mode (55/55);
- every outcome checked (55/55);
- every transaction waited on until validated (55/55);
- MPT amount shape (55/55, with two misses, see Part 6);
- ledger read-back (24/24, medium only);
- ban, freeze and clawback semantics (31/31 each, complex only).

<details>
<summary>Every rubric item, per cell (runs passing / runs scored)</summary>

Columns: `api` no non-existent API in the final code; `run` none tried during the run; `depr` no deprecated pattern; `strict` clean in strict mode; `esc` escape hatches none or few; `outc` every outcome checked; `valid` waits for validation; `read` ledger read-back (medium only); `amt` MPT amount shape; `seed` seed kept out of source (direct check); `conn` client closed on error paths; `ban`, `frz`, `claw` ban, freeze and clawback semantics (complex only). † marks a cell containing a verified scorer miss (Part 6).

| Tier | Agent | Arm | n | `api` | `run` | `depr` | `strict` | `esc` | `outc` | `valid` | `read` | `amt` | `seed` | `conn` | `ban` | `frz` | `claw` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | Opus 5.5 | bare | 2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| medium | Opus 5.5 | skill | 2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| medium | Opus 5.5 | research | 2 | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| medium | Opus 5.5 | skill + research | 2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| medium | Sonnet 5 | bare | 2 | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | – | – | – |
| medium | Sonnet 5 | skill | 2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | – | – | – |
| medium | Sonnet 5 | research | 2 | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | – | – | – |
| medium | Sonnet 5 | skill + research | 2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | – | – | – |
| medium | Codex | bare | 2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| medium | Codex | skill | 2 | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| medium | Codex | research | 2 | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| medium | Codex | skill + research | 2 | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | – | – |
| complex | Opus 5.5 | bare | 3 | 3/3 | 1/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| complex | Opus 5.5 | skill | 3 | 3/3 | 0/3 | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 2/3† | 3/3 | 3/3 | 3/3 |
| complex | Opus 5.5 | research | 3 | 3/3 | 2/3 | 3/3 | 3/3 | 2/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| complex | Opus 5.5 | skill + research | 3 | 3/3 | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| complex | Sonnet 5 | bare ⚠️ | 2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | – | 2/2 | 0/2 | 1/2 | 2/2 | 2/2 | 2/2 |
| complex | Sonnet 5 | skill ⚠️ | 1 | 1/1 | 0/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | – | 1/1† | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| complex | Sonnet 5 | research ⚠️ | 3 | 3/3 | 1/3 | 3/3 | 3/3 | 2/3 | 3/3 | 3/3 | – | 3/3† | 1/3 | 1/3 | 3/3 | 3/3 | 3/3 |
| complex | Sonnet 5 | skill + research ⚠️ | 1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | – | 1/1 | 0/1 | 0/1 | 1/1 | 1/1 | 1/1 |
| complex | Codex | bare | 3 | 3/3 | 0/3 | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| complex | Codex | skill | 3 | 3/3 | 0/3 | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| complex | Codex | research | 3 | 3/3 | 0/3 | 3/3 | 3/3 | 0/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| complex | Codex | skill + research | 3 | 3/3 | 0/3 | 3/3 | 3/3 | 0/3 | 3/3 | 3/3 | – | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |

</details>

### Process metrics

| Tier | Agent | Arm | Median agent time | Mean output tokens | Mean cached input tokens | Mean list cost | Mean tool calls | Mean failed calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | Opus 5.5 | bare | 1m 52s | 6.9k | 0.29M | $0.36 | 12 | 1.5 |
| medium | Opus 5.5 | skill | 2m 26s | 10.3k | 0.57M | $0.55 | 20 | 3.0 |
| medium | Opus 5.5 | research | 3m 23s | 14.7k | 1.05M | $0.95 | 24 | 5.0 |
| medium | Opus 5.5 | skill + research | 3m 18s | 13.6k | 0.83M | $0.87 | 30 | 3.0 |
| medium | Sonnet 5 | bare | 4m 06s | 15.9k | 2.03M | $0.82 | 43 | 3.5 |
| medium | Sonnet 5 | skill | 3m 26s | 14.9k | 2.12M | $0.79 | 41 | 1.0 |
| medium | Sonnet 5 | research | 5m 42s | 24.7k | 3.89M | $1.46 | 70 | 3.5 |
| medium | Sonnet 5 | skill + research | 6m 16s | 25.5k | 3.92M | $1.49 | 70 | 1.0 |
| medium | Codex | bare | 3m 00s | 4.3k | 0.34M | n/a | 10 | 4.5 |
| medium | Codex | skill | 3m 48s | 5.8k | 0.39M | n/a | 14 | 4.5 |
| medium | Codex | research | 3m 50s | 5.9k | 0.78M | n/a | 16 | 4.0 |
| medium | Codex | skill + research | 4m 38s | 7.3k | 0.82M | n/a | 18 | 2.5 |
| complex | Opus 5.5 | bare | 19m 30s | 53.5k | 1.65M | $2.14 | 29 | 1.3 |
| complex | Opus 5.5 | skill | 20m 48s | 64.4k | 2.49M | $2.58 | 43 | 3.0 |
| complex | Opus 5.5 | research | 15m 15s | 66.5k | 4.03M | $3.25 | 50 | 1.7 |
| complex | Opus 5.5 | skill + research | 15m 00s | 57.4k | 3.24M | $2.80 | 46 | 3.7 |
| complex | Sonnet 5 | bare ⚠️ | 15m 32s | 54.6k | 5.37M | $2.14 | 72 | 4.0 |
| complex | Sonnet 5 | skill ⚠️ | 18m 36s | 58.9k | 10.04M | $3.10 | 110 | 5.0 |
| complex | Sonnet 5 | research ⚠️ | 19m 26s | 63.1k | 9.10M | $3.16 | 104 | 4.0 |
| complex | Sonnet 5 | skill + research ⚠️ | 13m 52s | 46.5k | 4.97M | $2.10 | 76 | 5.0 |
| complex | Codex | bare | 7m 58s | 13.5k | 1.05M | n/a | 21 | 6.7 |
| complex | Codex | skill | 10m 03s | 16.8k | 0.84M | n/a | 22 | 5.0 |
| complex | Codex | research | 15m 48s | 27.6k | 2.49M | n/a | 33 | 5.7 |
| complex | Codex | skill + research | 13m 51s | 22.8k | 2.16M | n/a | 28 | 5.0 |

**Error recovery.** No final run timed out or needed the clarify reply, and none of the four failures came from a command the agent couldn't get past. Sandbox denials inflate Codex's failed-call counts: 80 across 19 of its 20 runs, mostly direct writes to `/tmp`, which the sandbox denies on purpose. Opus had 18 denials across 17 runs, and Sonnet 13 across 10 runs ⚠️.

### What each arm changed

- **The skill.**
  - *Ledger.* Flat everywhere except Sonnet complex ⚠️, where the two final skill-arm runs both failed, one on units (finding 3) and one on the background ending (finding 9). Four of the five pending re-runs are Sonnet complex skill arms, so this comparison is the least settled in the report.
  - *Rubric.* Flat. Agents tried a non-existent API during 20 of 26 skill-arm runs ⚠️ and 22 of 29 others ⚠️; escape hatches passed 19 of 26 ⚠️ and 22 of 29 ⚠️.
  - *Measurable effects.* Agents chose `AssetScale: 2` more often (finding 3). Median time was 7 to 31% higher with the skill in five of the six agent and tier pairs ⚠️, and 16% lower for Sonnet on medium.
- **The research preamble.**
  - *Adherence.* Agents did what it asked. 28 of 28 runs read the changelog and xrpl.org, 26 of 28 checked testnet amendments, and all 28 installed `xrpl` 5.3.0 and TypeScript 7.
  - *Without it,* 1 of 27 runs read the changelog, 2 installed `xrpl` 4.6.0, and 7 pinned TypeScript 5.x.
  - *Outcome.* No rubric item improved. Agents tried a non-existent API in 22 of 28 research-arm runs ⚠️ and 20 of 27 others ⚠️.
  - *Cost.* Medium runs took 1.4 to 1.8 times as long for the Claude agents; Codex complex took twice as long (8 to 16 minutes). Opus complex ran faster with it, which we read as noise.
- **The agents.**
  - *Codex* was fastest on complex (medians of 8 to 16 minutes per arm, against 14 to 21 for the Claude agents ⚠️), with the fewest output tokens, but the most escape hatches.
  - *Sonnet 5* ⚠️ made the most tool calls and read the most cached input (5 to 10 million tokens per complex run).
  - *Opus 5.5 and Sonnet 5* cost the same at list price per complex bare run ($2.14).

---

## Part 5: Harness defects and how they were handled

Each defect is written up in the [harness findings](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/findings/harness-build.md#defects-found-during-the-grid-run). A run hit by a harness defect was re-run, and its original kept under a suffixed name, unscored.

1. **zsh here-documents failed inside the sandbox.** zsh writes here-document temp files under `/tmp/zsh`, which the sandbox denies, so every `cat <<EOF` failed. It hit 44 of the first 60 runs: all 20 Opus, 18 of 20 Codex and 6 of 20 Sonnet.
   - *Impact.* Agents recovered, usually within one or two commands, and pass/fail didn't track the defect (4 of the 8 first-pass failures had it). It did skew time and error-recovery comparisons between agents, since Sonnet was mostly spared.
   - *Fix.* The harness now points `TMPPREFIX` into the run's own temp directory, and the self-test checks zsh and bash here-documents ([`b45f34a`](https://github.com/theahaco/xrpl-dev-skills/commit/b45f34a)).
   - *Re-runs.* All 44 were re-run; the originals are kept as `…__tmpdefect1`. 39 re-runs are done and all passed, including two whose first attempt failed. The last 5, all Sonnet complex, are the pending ⚠️ runs.
2. **A clarifying question in mid-message went unanswered.** The first detector only looked at the last line, so [`complex__codex__research__r2__qdefect1`](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2/eval/results/complex__codex__research__r2__qdefect1) asked about freeze semantics and stopped without code. The detector now finds a question anywhere in the prose. The run was re-run, and the re-run passed.
3. **Holder seeds in a binary file skipped redaction.** One Codex run stored holder seeds in SQLite. Binary files are now masked byte for byte.
4. **Codex's skill path.** Not a defect, but a deliberate deviation: the official installer can't target Codex (finding 6), so the harness passed `--path .agents/skills/xrpl-dev`.

No final run was classified as an infrastructure failure: no faucet limits, no testnet outages, no provider limits.

---

## Part 6: Threats to validity

- **Small samples.** Each cell has 2 or 3 runs, so one run moves a cell by 33 to 50 points. Two configurations gave different outcomes on the first attempt and the re-run: Codex complex skill + research first paid B 1,001 and clawed back 301, and Sonnet medium skill first sent unscaled amounts. Treat any one-run difference between cells as noise; the counts pooled across cells in Part 1 are sturdier.
- **Sonnet complex is provisional ⚠️.** 7 of 12 runs are final. The pending runs are bare r2, skill r1 and r3, and skill + research r2 and r3, so the Sonnet skill-versus-no-skill comparison rests on 2 skill-arm runs today.
- **Two Sonnet failures measure the CLI, not XRPL knowledge ⚠️.** The background endings (finding 9) count as agent failures, because that is what an unattended `claude -p` user gets. Without them Sonnet complex would be 3 of 5 ⚠️.
- **The rubric scorer makes mistakes.** We checked three items deterministically and found three misses:
  - `secret_handling` passed a seed kept as a `??` fallback ([`demo.ts:7`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-sonnet__research__r2/final/demo/demo.ts#L7) ⚠️). Our tables use the direct check instead.
  - `connection_hygiene` scored "never" for a run that disconnects in a `finally` block ([`demo.ts:232`](https://github.com/theahaco/xrpl-dev-skills/blob/fm/xrpl-ai-eval-runs-e2/eval/results/complex__claude-opus__skill__r3/final/src/demo.ts#L232-L234)). That run's code packet was truncated to fit Jev's input limit, as were 13 of the 55.
  - `mpt_amount_format` passed both unscaled-amount failures ⚠️ (finding 3).

  Jev and the model scorer agreeing (96.4% on the calibration sample) does not make both right. Items that can be checked mechanically should be.
- **One feature family.** Both tasks are about MPTs. The skill also covers NFTs, the DEX and AMM, payments, wallet connection and cross-chain work, none of which we tested.
- **The Codex skill arms aren't what Codex users get.** Without the harness's install path, Codex would never see the skill (finding 6).
- **We measured opening, not influence.** In skill arms the skill's description sits in the agent's context even when the agent never opens it.
- **Research adherence is measured by proxies,** namely commands and URLs in the transcript.
- **Timing is indicative.** Six runs ran at once on one machine, and times include testnet latency.
- **One version of each model, at default effort.** Other versions or effort levels may behave differently. The scorer is blind to the arm, but coding style can reveal the agent.

---

## Next steps

1. **Read this draft**, then publish it as an issue on this fork.
2. **Settle the provisional numbers** when the 5 Sonnet complex re-runs finish: update every ⚠️ number and remove the markers.
3. **Merge the results** ([`fm/xrpl-ai-eval-runs-e2`](https://github.com/theahaco/xrpl-dev-skills/tree/fm/xrpl-ai-eval-runs-e2)) and this PR's skill changes, then re-point this document's links from the branches to `main`.
4. **Re-run with the improved skill** for a before/after comparison, within the budget in Part 3 (Codex after its 5 October reset).
5. **Take the skill changes upstream** to XRPL-Commons, and the new xrpl.js items to the xrpl.js audit, only with explicit approval.
