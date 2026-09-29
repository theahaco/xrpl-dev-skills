Everything is in place. I haven't committed anything, since you didn't ask for that — let me know if you'd like these committed.

## Summary

Built an issuer-side MPT compliance module in `src/mptIssuer.ts` and a demo in `src/demo.ts`, both in strict TypeScript against `xrpl@5.3.0`.

**Design** (verified directly against the installed package's compiled validation logic, not just docs):
- Issuance created with `tfMPTRequireAuth` (allowlist), `tfMPTCanLock` (freeze), `tfMPTCanClawback`, `tfMPTCanTransfer`.
- **Allowlist**: two-step — holder self-submits `MPTokenAuthorize` to opt in (`optInToMpt`), then issuer calls `approveHolder` to set `lsfMPTAuthorized`.
- **Clawback**: `clawback(holder, issuanceId, value)`; `clawbackAll` sweeps the full balance.
- **Per-holder / global freeze**: `MPTokenIssuanceSet` with `tfMPTLock`/`tfMPTUnlock`, with or without the `Holder` field.
- **Ban**: since it's not a native primitive, `banHolder` composes clawback (zero the balance) + lock (block movement) + revoke authorization (block future receipt under `RequireAuth`), and remembers the address so this module instance refuses to re-approve it.
- A shared `submitAndAssertSuccess` helper checks the actual `TransactionResult` rather than trusting SDK-level success — deliberately, since research surfaced a prior audit (by a `willemneal` GitHub account, an XRPL MPT API-surface review) documenting real xrpl.js bugs like silently-successful failed retries and case-sensitive field drops.

**Demo run against Testnet** — all end-state assertions passed:
- Issuance `01427E6E1AAC3C2CC9FBE413C534C69408999404F198C91F`, issued from your account.
- Holder A: 500 held, unfrozen (was frozen, then unfrozen).
- Holder B: 1000 sent, 300 clawed back → 700 held, frozen.
- Holder C: sent 200, then banned (0 balance, locked, unauthorized).
- Global freeze applied and lifted.

`result.json` in the project root has the issuance ID and holder addresses in the requested format.

One cosmetic note: the SDK warns that the demo's metadata isn't fully XLS-89-compliant (`asset_subclass` recommended when `asset_class` is `rwa`) — harmless, doesn't affect any ledger behavior, just token discoverability in explorers.