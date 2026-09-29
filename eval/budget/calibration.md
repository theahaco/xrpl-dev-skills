# Budget calibration, 2026-09-29

The evidence behind [`estimates.json`](estimates.json). The three calibration runs are complex tier, bare arm, rep 1, one per agent. They ran at the same time and count as real results.

| Run | Agent time | List price | Tokens (cached in / out) | Weekly quota before -> after |
| --- | --- | --- | --- | --- |
| `complex__claude-opus__bare__r1` | 1118 s | $2.33 | 1.97M / 57.7k | Claude 91 -> 90 |
| `complex__claude-sonnet__bare__r1` | 1038 s | $2.55 | 6.99M / 63.1k | Claude 91 -> 90 |
| `complex__codex__bare__r1` | 862 s | n/a | 1.06M / 25.8k (plus 64.7k uncached in) | Codex 94 -> 93 |

Each run records its own quota readings in `run.json` under `quota`. All three passed every ledger criterion.

Scoring those three runs with `--calibrate` (both scorers on every item) cost $0.70, $0.50 and $0.59 on the model scorer (`score.json`, `modelScorer.costUsd`). Afterwards the Claude weekly window still read 90%.

## Claude: percent per dollar

quota-axi reports whole percentages. Over the calibration, the Claude weekly window went from 91 to 90. That covered $4.88 of agent runs, $1.79 of scoring, and this orchestrating session, which draws on the same allowance. A one-point step can hide up to two points of real use, so the conservative ratio is:

```
2 points / $4.88 of agent runs = 0.41 % per dollar
```

The scoring spend and the orchestrator's use are left out of the denominator, so all of it is charged to the runs. Earlier data agrees: each medium Sonnet smoke attempt ($0.70 to $0.81) left the reading unchanged. Per-run estimates are list-price cost x 0.41, rounded up.

## Codex

Codex reports no dollar cost. The one run moved the weekly window from 94 to 93 on its own, so 2 points per complex run is the upper bound.

## Uncalibrated cells

Medium was not in the calibration pass, which is complex-only per the plan. Claude medium uses the Sonnet smoke run ($0.75). Codex medium is half its complex figure, the same medium/complex ratio as Claude.

## Refinement

These numbers lean high on purpose: a high estimate only makes the gate refuse sooner, while a low one could spend the reserve kept for the before/after re-run. The gate re-reads the live quota before every set, so real spend below the estimate simply leaves more room for later sets. The quota deltas across each finished set are recorded below as they come in.
