This all looks solid and matches what actually ran successfully against testnet. The module, demo, and result all check out. Here's a summary of what was built and verified.

## Summary

**Research performed first:**
- `xrpl` npm package: latest is `5.3.0` (published 2026-09-23) — installed and used its bundled TypeScript source directly to verify exact field/flag names for every transaction used, rather than trusting docs summaries.
- Read xrpl.org reference pages for `MPTokenIssuanceCreate`, `MPTokenIssuanceSet`, `MPTokenAuthorize`, `Clawback`, and the `MPTokenIssuance`/`MPToken` ledger objects.
- Queried testnet directly (`feature` RPC) and confirmed `MPTokensV1` and `Clawback` amendments are enabled; `DynamicMPT` is **not** enabled, which is why all capability flags (lock, require-auth, clawback, transfer) are set once at issuance creation rather than mutated later.
- TypeScript's latest is now major version 7 (Go-ported compiler); `ts-node` isn't compatible with it, so I used `tsx` to run the demo and `tsc --noEmit` (strict mode) purely for type-checking.

**Built in `/private/tmp/ws/b34dc1a9b26c/project`:**
- `src/mptIssuer.ts` — reusable `MptComplianceIssuer` class: `createIssuance`, `authorizeHolder`/`unauthorizeHolder` (allowlist), `issue`, `clawback`, `freezeHolder`/`unfreezeHolder`, `globalFreeze`/`globalUnfreeze`, `banHolder` (clawback-to-zero + lock + de-authorize), plus `getIssuanceState`/`getHolderState` readers. A separate `optInToIssuance` helper represents the holder-signed side of allowlisting, since an issuer backend shouldn't hold custody of holder keys.
- `src/demo.ts` — funds three new holder accounts from your issuer account, exercises every control, and verifies the final ledger state programmatically before writing `result.json`.

**Ran against testnet successfully** — all assertions passed, and I additionally confirmed the ban is real by attempting a payment to banned holder C afterward, which the ledger rejected with `tecNO_AUTH`.

**Final state (from this run, in `result.json`):**
- Issuance `01427E45B0B5DC397907B64BC825DBE4340EFBF589F1D5DF`
- Holder A: 500 tokens, frozen then unfrozen (not frozen at end)
- Holder B: 1000 sent, 300 clawed back → 700, frozen at end
- Holder C: 250 sent, then banned — 0 balance, unauthorized, locked, confirmed unable to receive again
- Global freeze applied and lifted

One design note worth flagging: I did not enable `tfMPTCanTrade` or `tfMPTCanEscrow` on the issuance, keeping the token's surface area minimal (issuer↔holder and holder↔holder payments only) — appropriate for a compliance-first stablecoin, but let me know if you want DEX/escrow support added later (note it can only be granted now since `DynamicMPT` isn't live on testnet yet, so it would require reissuing).