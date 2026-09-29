Good, it's there (the earlier `find` just filtered oddly). Everything is in place. Here's a summary of what was built and verified.

## Summary

**Research performed first:**
- `xrpl` npm package latest is `5.3.0` (published 2026-09-23); installed it plus TypeScript 7, tsx, and current `@types/node`.
- Read xrpl.org reference docs for `MPTokenIssuanceCreate`, `MPTokenIssuanceSet`, `MPTokenAuthorize`, `Clawback`, and the `MPToken`/`MPTokenIssuance` ledger objects, then cross-checked every field/flag against the actual TypeScript source shipped in the npm package.
- Queried testnet directly (`feature` RPC) and confirmed `MPTokensV1`, `Clawback`, and `fixMPTDeliveredAmount` are enabled (`DynamicMPT` is not, so no `ImmutableFlags` usage).

**Built in `/private/tmp/ws/621dd08a935e/project/src/` (strict TypeScript):**
- `amounts.ts` — BigInt-safe decimal ⇄ base-unit conversion (no floats).
- `txHelpers.ts` — submit/sign/wait wrapper that verifies `meta.TransactionResult === 'tesSUCCESS'` (submission success alone isn't validation).
- `mptIssuer.ts` — the reusable `MptIssuer` class: `createIssuance`, `approveHolder`/`revokeHolderAuthorization` (allowlist), `sendTokens`, `clawback`/`clawbackAll`, `freezeHolder`/`unfreezeHolder`, `globalFreeze`/`globalUnfreeze`, `banHolder`, plus state readers.
- `holderActions.ts` — holder-side opt-in (kept separate since it's signed by the holder, not the issuer backend).
- `demo.ts` — exercises every control against testnet with self-verifying assertions.

**One real bug caught along the way:** my first assumption that a lock blocks *all* payments to a holder was wrong — XRPL's MPT lock only blocks holder-to-holder movement, leaving a deliberate issuer remediation channel (same as trust-line "deep freeze"). I verified this via docs/spec research and fixed the demo's test expectations rather than the implementation. A second bug (rippled omits `MPTAmount`/`Flags` from the ledger entry when they're zero) was caught and fixed via direct ledger inspection.

**Final state, independently verified via raw JSON-RPC `ledger_entry` calls (not just the module's own code):**
- Issuance flags = 102 (CanLock, RequireAuth, CanClawback, CanTransfer), not globally locked, outstanding = 1200.
- Holder A: 500, authorized, unlocked.
- Holder B: 700, authorized, locked.
- Holder C: 0 (no MPToken amount field), unauthorized, locked (banned).

`result.json` was written with the issuance ID and all three holder addresses.