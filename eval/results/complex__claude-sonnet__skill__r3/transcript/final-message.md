The issuer module, demo, and `result.json` are all built and verified on testnet. I did not commit anything — let me know if you'd like these committed.

**What's in place** (`/private/tmp/ws/ac80b8a86608/project`):
- `src/mptIssuer.ts` — the reusable `MPTIssuer` class: `create`, `approveHolder`/`revokeApproval` (allowlist), `send`, `clawback`, `ban`, `freezeHolder`/`unfreezeHolder`, `freezeGlobal`/`unfreezeGlobal`, plus state getters.
- `src/mptHolder.ts` — holder-side opt-in helper.
- `src/mptState.ts` — ledger-state reads (issuance + per-holder) via `ledger_entry`.
- `src/txSubmit.ts` — submit/sign/wait helper with fee-escalation guard and strict `tesSUCCESS` enforcement for compliance actions.
- `src/demo.ts` — end-to-end demo (`npm run demo`), exercises every control including negative-path tests (unapproved holder rejected, frozen holder blocked, globally-frozen blocked, banned holder blocked), then asserts final state and writes `result.json`.

**One correctness issue worth flagging:** I initially assumed XRPL's native per-holder/global MPT lock would block the issuer from *sending* to a locked holder. Testnet proved otherwise — the protocol lock only restricts the holder's own outgoing transfers; the issuer can still mint to a locked account. Since your spec requires a frozen holder to be blocked from receiving too, I added that as an explicit application-layer guard in `MPTIssuer.send()` (checks allowlist/lock/global-lock before ever submitting a payment). The demo documents and exercises this distinction directly.

Final state, independently verified via raw `ledger_entry` queries (not just the module's own reads):
- A: balance 500, approved, unfrozen
- B: balance 700 (1000 − 300 clawed back), approved, frozen
- C: balance 0, banned (unapproved), not on the token
- Issuance: not globally frozen

`result.json` has been written with the real issuance ID and holder addresses from this run.