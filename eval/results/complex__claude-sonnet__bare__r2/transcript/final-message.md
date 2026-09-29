The project is complete and verified. Here's a summary:

**Module** (`src/mptIssuer.ts`) — a strict-TypeScript `MptIssuer` class wrapping XRPL Multi-Purpose Token transactions (`MPTokenIssuanceCreate`, `MPTokenIssuanceSet`, `MPTokenAuthorize`, `Clawback`, `Payment`) with:
- **Allowlist** — `optIn`/`approveHolder`/`revokeHolderApproval`, backed by the `RequireAuth` flag
- **Clawback** — `clawback`/`clawbackAll`
- **Bans** — `ban()` = clawback to zero + revoke allowlist authorization, so a banned address holds nothing and can't be paid again
- **Per-holder freeze** — `freezeHolder`/`unfreezeHolder`
- **Global freeze** — `globalFreeze`/`globalUnfreeze`
- Status reads (`getHolderStatus`, `getIssuanceStatus`) via direct `ledger_entry` lookups

One important finding from testing against real testnet behavior: XRPL's MPT "lock" (both per-holder and global) only blocks *peer-to-peer* transfers on-ledger — rippled still lets the issuer pay or debit a locked holder directly, mirroring legacy trust-line freeze semantics. Since the task requires a frozen holder to be fully blocked and global freeze to stop *all* movement, `pay()` adds an application-level guard (`MptComplianceError`) enforcing that on top of the ledger's own protection.

**Demo** (`src/demo.ts`, run via `npm run demo`) exercised every control against testnet, including negative tests (frozen holder blocked from sending/receiving, banned address blocked from receiving, payment blocked during global freeze), and asserted the exact final state.

Final verified ledger state (independently re-queried, not just from the script's own assertions):
- Issuance `0142AC97CA66BD5677AF4486998CF9F631F27FEA9BB3C1C4`: allowlist, clawback, and lock all enabled; not globally locked
- A: authorized, unfrozen, balance 500
- B: authorized, **frozen**, balance 700 (1000 sent, 300 clawed back)
- C: **unauthorized** (banned), balance 0 (250 sent, then fully clawed back)

`result.json` is written with the issuance ID and the three holder addresses. Note: the issuer account's testnet balance was topped up via the faucet during debugging (now ~105 XRP) since several iterations were needed to pin down real ledger behavior — no action needed on your end.