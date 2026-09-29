Everything is built, typechecked, and verified against testnet. Summary:

**Module** (`src/`):
- `issuer.ts` — `MptIssuer` class: `createIssuance`, `approveHolder` (allowlist), `sendTokens`, `clawback`, `freezeHolder`/`unfreezeHolder`, `globalFreeze`/`globalUnfreeze`, `banHolder` (clawback + revoke authorization), `getIssuance`/`getHolder` (state queries)
- `amounts.ts` — BigInt-safe decimal ⟷ base-unit conversion
- `txSubmit.ts` — autofill/sign/submit/wait-for-validation wrapper that throws unless the validated result is `tesSUCCESS`
- `mptFlags.ts`, `xrplClient.ts`, `index.ts`

The issuance is created with `tfMPTRequireAuth`, `tfMPTCanLock`, and `tfMPTCanClawback` all enabled.

**Demo** (`demo/demo.ts`) ran live against testnet and exercised every control, including negative tests (payments correctly rejected before opt-in, before approval, while frozen, during global freeze, and after banning). One noteworthy protocol behavior I verified empirically and documented in the code: both per-holder and global locks exempt the issuer as counterparty — a frozen/globally-locked holder can still be reached by issuer-initiated payments and clawback, but is blocked from moving funds to/from other holders. I adjusted the demo's checks (and the module's JSDoc) to reflect this correctly rather than assume.

Final ledger state (independently verified via `ledger_entry`):
- A: balance 500, unlocked, authorized
- B: balance 700, **locked**, authorized
- C: balance 0, unauthorized (banned)
- Issuance: not globally locked, outstanding = 1200

`result.json` is written with the issuance ID and holder addresses. Nothing has been committed — let me know if you'd like that done.