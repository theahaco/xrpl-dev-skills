# Grid results

Generated from every `results/<tier>__<agent>__<arm>__r<rep>` directory. Superseded attempts (`__qdefect1`) are left out.

## Ledger pass rate per cell

| Agent | Tier | bare | skill | research | skill-research | Total |
| --- | --- | --- | --- | --- | --- | --- |
| claude-opus | medium | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| claude-opus | complex | 3/3 | 3/3 | 3/3 | 3/3 | 12/12 |
| claude-sonnet | medium | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| claude-sonnet | complex | 3/3 | 2/3 | 1/3 | 1/3 | 7/12 |
| codex | medium | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| codex | complex | 3/3 | 3/3 | 3/3 | 3/3 | 12/12 |

By arm, medium: bare 6/6, skill 6/6, research 6/6, skill-research 6/6.
By arm, complex: bare 9/9, skill 8/9, research 7/9, skill-research 7/9.
All runs: 55/60 pass.

## Failing runs

| Run | Failed criteria |
| --- | --- |
| `complex__claude-sonnet__research__r1` | result_json |
| `complex__claude-sonnet__research__r2` | holder_a_state, holder_b_state, holder_b_sent_1000, holder_b_clawback_300 |
| `complex__claude-sonnet__skill-research__r1` | result_json, holder_a_state, holder_a_freeze_cycle, holder_b_state, holder_b_sent_1000, holder_b_clawback_300, holder_c_banned, holder_c_received_before_ban, global_freeze_cycle, outstanding_consistent |
| `complex__claude-sonnet__skill-research__r3` | result_json, holder_a_state, holder_a_freeze_cycle, holder_b_state, holder_b_sent_1000, holder_b_clawback_300, holder_c_banned, holder_c_received_before_ban, global_freeze_cycle, outstanding_consistent |
| `complex__claude-sonnet__skill__r2` | holder_a_state, holder_b_state, holder_b_sent_1000, holder_b_clawback_300 |

## Rubric items failed (runs failing / runs scored)

| Item | claude-opus | claude-sonnet | codex | skill arms | no-skill arms |
| --- | --- | --- | --- | --- | --- |
| hallucinated_api | 0/20 | 0/20 | 0/20 | 0/30 | 0/30 |
| hallucination_during_run | 14/20 | 13/20 | 19/20 | 23/30 | 23/30 |
| deprecated_patterns | 0/20 | 0/20 | 0/20 | 0/30 | 0/30 |
| strict_type_errors | 0/20 | 0/20 | 0/20 | 0/30 | 0/30 |
| type_escape_hatches | 3/20 | 2/20 | 10/20 | 8/30 | 7/30 |
| outcome_checks | 0/20 | 0/20 | 0/20 | 0/30 | 0/30 |
| waits_for_validation | 0/20 | 0/20 | 0/20 | 0/30 | 0/30 |
| mpt_amount_format | 0/20 | 0/20 | 0/20 | 0/30 | 0/30 |
| secret_handling | 0/20 | 15/20 | 0/20 | 7/30 | 8/30 |
| connection_hygiene | 1/20 | 5/20 | 0/20 | 3/30 | 3/30 |
| ban_semantics | 0/12 | 0/12 | 0/12 | 0/18 | 0/18 |
| freeze_semantics | 0/12 | 0/12 | 0/12 | 0/18 | 0/18 |
| clawback_semantics | 0/12 | 0/12 | 0/12 | 0/18 | 0/18 |
| ledger_readback | 0/8 | 0/8 | 0/8 | 0/12 | 0/12 |

Unresolved rubric items: none.

## Jev / model scorer agreement

Calibration sample (every item scored by both): 8 runs (`complex__claude-opus__skill__r1`, `complex__claude-sonnet__bare__r1`, `complex__claude-sonnet__skill__r1`, `complex__codex__skill__r1`, `medium__claude-opus__bare__r1`, `medium__claude-sonnet__bare__r1`, `medium__claude-sonnet__skill-research__r1`, `medium__codex__bare__r1`).

- Agreement: 92/96 items (95.8%). On items where Jev was at or above the 0.6 floor: 80/81.
- Per item: hallucinated_api 8/8, hallucination_during_run 8/8, deprecated_patterns 7/8, strict_type_errors 8/8, type_escape_hatches 6/8, outcome_checks 7/8, waits_for_validation 8/8, mpt_amount_format 8/8, secret_handling 8/8, connection_hygiene 8/8, ban_semantics 4/4, freeze_semantics 4/4, clawback_semantics 4/4, ledger_readback 4/4.
- Over every item both scorers answered (calibration plus sub-floor fallbacks): 181/202 (89.6%).
- Final answers across the grid: 610 from Jev at or above the floor, 122 from the model scorer.

## Cost and time

| Agent | Tier | Runs | Median agent time | List price (sum) | Output tokens (sum) | Clarify replies | Timed out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus | medium | 8 | 3 min | $5.44 | 91k | 0 | 0 |
| claude-opus | complex | 12 | 18 min | $32.34 | 725k | 0 | 0 |
| claude-sonnet | medium | 8 | 5 min | $9.12 | 162k | 0 | 0 |
| claude-sonnet | complex | 12 | 19 min | $35.68 | 745k | 0 | 0 |
| codex | medium | 8 | 4 min | n/a | 47k | 0 | 0 |
| codex | complex | 12 | 13 min | n/a | 242k | 0 | 0 |

Claude agent runs: $82.57 at list price. Blind model scorer: $14.40. Jev: 300 requests.

## Environment

- claude-opus: claude-opus-5-5 (2.1.281 (Claude Code), effort default)
- claude-sonnet: claude-sonnet-5 (2.1.281 (Claude Code), effort default)
- codex: gpt-6-astra (codex-cli 0.158.0, effort default (unset in config))
- Installed xrpl: 5.3.0, 4.6.0.
- Upstream skill commit: eb450f5a4575e48ca196ed0daad72420d4db6d91.
- Model mismatches: none.
- Infra re-runs: none. Suspect runs: none.
- Runs with sandbox denials (friction, never infra): 48.
