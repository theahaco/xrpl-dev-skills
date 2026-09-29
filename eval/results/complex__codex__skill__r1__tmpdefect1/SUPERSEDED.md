# Superseded: harness defect

The sandbox denied zsh's here-document temp files (`TMPPREFIX` defaulted to `/tmp/zsh`), so this run hit "can't create temp file for here document" at least once, which a clean machine would not have. Fixed in b45f34a. This attempt is kept as evidence only: it is not scored, and `complex__codex__skill__r1` is the re-run on the fixed harness.
