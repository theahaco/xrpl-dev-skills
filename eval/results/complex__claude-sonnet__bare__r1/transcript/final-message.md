Everything is in place. This is a no-commits-yet repo, so I'll leave version control to you unless you'd like me to commit. Here's a summary of what was built.

## Summary

**`src/mptIssuer.ts`** — reusable issuer module (`MPTIssuer` class + `optInToIssuance` helper), built on the `xrpl` npm package's native MPT support:

- **Allowlist** — issuance created with `tfMPTRequireAuth`; holders opt in (`MPTokenAuthorize`), then the issuer authorizes (`approveHolder`)/de-authorizes (`revokeHolderAuthorization`) them.
- **Clawback** — `tfMPTCanClawback` on the issuance + `clawback(holder, amount)`.
- **Bans** — `ban(holder)` claws back the full balance then revokes authorization, so the holder ends at zero balance and any future payment to them is rejected (`tecNO_AUTH`) since they're no longer allowlisted.
- **Per-holder freeze** — `freezeHolder`/`unfreezeHolder` via `MPTokenIssuanceSet` with `Holder` + `tfMPTLock`/`tfMPTUnlock`.
- **Global freeze** — `globalFreeze`/`globalUnfreeze`, same transaction without a `Holder`.
- Read helpers (`getIssuanceState`, `getHolderState`, `getBalance`) backed by direct `ledger_entry` lookups.

One correctness note worth flagging: I initially assumed a lock would block issuer↔holder payments too. Live testnet testing (and XRPL docs) showed locks only block **holder-to-holder** transfers (`tecLOCKED`) — the issuer can always pay/redeem/clawback regardless of lock state. I verified this empirically before finalizing the module's doc comments and the demo's assertions.

**`src/demo.ts`** — ran end-to-end against testnet from your issuer account, funding three fresh holders (A, B, C) from the faucet, and exercising every control with live pass/fail assertions (including proving the allowlist and locks actually reject what they should). Final on-chain state, independently re-verified via a fresh ledger query after the run:

- Issuance flags: `RequireAuth`, `CanClawback`, `CanLock` all set; not globally locked.
- A: balance 500, unlocked (frozen then unfrozen during the run).
- B: balance 700 (1000 sent, 300 clawed back), locked.
- C: balance 0, unauthorized (banned) — confirmed a post-ban payment attempt fails with `tecNO_AUTH`.

`result.json` is written in the exact requested shape with the real issuance ID and holder addresses.