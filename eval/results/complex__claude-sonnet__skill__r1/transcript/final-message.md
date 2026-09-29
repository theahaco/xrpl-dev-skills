Everything's in place and `.env` (with the real seed) is correctly excluded from git. No commits exist yet in this repo, so I haven't created any — let me know if you'd like me to commit this.

## Summary

Built a production-quality TypeScript MPT issuer module in `src/`:

- **`src/mptIssuer.ts`** — reusable `MptIssuer` class: `createIssuance`, `approveHolder`/`revokeHolderAuthorization` (allowlist), `sendTokens`, `clawback`, `freezeHolder`/`unfreezeHolder`, `globalFreeze`/`globalUnfreeze`, `banHolder`, plus `getHolderState`/`getIssuanceState` for reading back ledger state. Every write waits for ledger validation and throws a typed `MptTransactionError` on any non-`tesSUCCESS` result.
- **`src/holder.ts`** — holder-side opt-in (`MPTokenAuthorize`), kept separate since it must be signed by the holder's own key, not the issuer's.
- **`src/demo.ts`** — exercises every control against testnet, with `expectBlocked` checks that actually attempt the forbidden action and confirm it's rejected (not just that a flag got set).

Two non-obvious protocol findings from testing against real testnet, not just types:
1. **MPT freeze doesn't block issuer→holder deposits** — rippled's `lsfMPTLocked` only stops the locked holder's own outgoing sends; an issuer can still pay into a locked account. Since the task requires a frozen holder to be blocked both ways, `sendTokens` now does an application-level pre-check (queries frozen/global-frozen state before submitting) so freeze behaves as fully bidirectional.
2. **Zero balances are omitted from `account_objects` JSON** (no `MPTAmount` field at all when balance is 0) — handled with an explicit default rather than crashing on `undefined`.

Final ledger state, independently re-verified with a raw query script separate from the module's own code:
- Issuance flags: RequireAuth + CanLock + CanClawback + CanTransfer, not globally locked, outstanding 1200.
- A: 500, unfrozen. B: 700, frozen. C: 0, unauthorized (banned).

`result.json` is written with the issuance ID and holder addresses. `.env` holds the issuer seed and is gitignored (never hardcoded in source).