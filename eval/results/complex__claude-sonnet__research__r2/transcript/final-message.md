## Summary

Built the issuer-side TypeScript module for a regulated MPT stablecoin, targeting testnet, and ran it end-to-end.

**Research done first:**
- `xrpl` npm latest is `5.3.0` (installed and used).
- Read xrpl.org docs for `MPTokenIssuanceCreate`, `MPTokenIssuanceSet`, `MPTokenAuthorize`, `Clawback`, and the `MPTokenIssuance`/`MPToken` ledger entries.
- Confirmed via direct RPC (`feature` command) that testnet has `MPTokensV1` and `Clawback` amendments enabled.
- Empirically verified on testnet (not just from docs) the non-obvious protocol behaviors: holders must opt in via their own `MPTokenAuthorize` before the issuer can approve them; a lock (per-holder or global) blocks any transfer that isn't directly to/from the issuer; banning = clawback-to-zero + issuer-side deauthorize (`tfMPTUnauthorize`), which the issuer can do unilaterally without the holder's cooperation.

**Delivered in `/private/tmp/ws/fe725856e133/project`:**
- `src/mptIssuer.ts` — `MptIssuer` class: `issue`, `approveHolder`, `sendTo`, `clawback`, `freezeHolder`/`unfreezeHolder`, `freezeGlobal`/`unfreezeGlobal`, `ban`, plus status queries. All mutating calls wait for ledger validation and throw on non-`tesSUCCESS`.
- `src/holderActions.ts` — the one holder-side action (`optIntoMpt`) needed before the issuer can approve someone, kept separate since it's signed by the holder, not the issuer.
- `src/submit.ts`, `src/index.ts` — shared submit helper and barrel export.
- `demo/demo.ts` — exercises every control against testnet and writes `result.json`.

**Demo ran against testnet and produced the exact required end state**, independently re-verified via raw RPC calls:
- A: authorized, balance 500, unlocked (frozen then unfrozen during the run).
- B: authorized, balance 700 (1000 − 300 clawback), locked.
- C: unauthorized, balance 0 (banned after holding 200); a follow-up payment attempt correctly failed with `tecNO_AUTH`.
- Issuance flags = 102 (`RequireAuth`+`CanLock`+`CanClawback`+`CanTransfer`), not globally locked (globally frozen then unfrozen during the run).

`result.json` is written with the real issuance ID and holder addresses.