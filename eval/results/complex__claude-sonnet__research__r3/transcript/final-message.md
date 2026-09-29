Everything is in place and clean.

## Summary

**Research done first:**
- `xrpl` npm latest is `5.3.0`, installed and inspected its TypeScript source directly (docs pages were often vague/wrong on edge cases like issuer-initiated unauthorize semantics, so I verified against the actual library source).
- Read xrpl.org docs for `MPTokenIssuanceCreate`, `MPTokenAuthorize`, `MPTokenIssuanceSet`, `Clawback`, `Payment` (MPT amounts), and the `MPTokenIssuance`/`MPToken` ledger objects.
- Confirmed via testnet RPC (`feature` command) that `MPTokensV1` and `Clawback` amendments are both enabled and supported on testnet.

**Built:** `src/mptIssuer.ts` — a reusable `MptIssuer` class (strict TypeScript) wrapping:
- `createIssuance` — creates the MPT with `tfMPTRequireAuth` (allowlist), `tfMPTCanLock` (freeze), `tfMPTCanClawback` enabled.
- `requestHolderOptIn` / `approveHolder` / `revokeHolderAuthorization` — allowlist/KYC flow.
- `freezeHolder` / `unfreezeHolder` / `globalFreeze` / `globalUnfreeze` — per-holder and global freeze via `MPTokenIssuanceSet`.
- `clawback` / `clawbackAll` — issuer clawback of any amount.
- `banHolder` — claws back the full balance then revokes authorization, so a banned holder ends at zero balance and can't be paid again (enforced by `tfMPTRequireAuth`).
- `getBalance`/`getIssuance`/`getMPToken`/`isGloballyFrozen`/`isHolderFrozen`/`isHolderAuthorized` — ledger state helpers.
- Every transaction is validated client-side (`xrpl`'s `validate`) and checked for `tesSUCCESS` before returning.

**Demo:** `src/demo.ts` ran end-to-end on testnet from your issuer account, creating 3 faucet-funded holders and exercising every control, including negative-path checks (payment to a banned holder correctly rejected with `tecNO_AUTH`; payment during global freeze correctly rejected with `tecLOCKED`).

**Verified independently** via raw `ledger_entry` RPC calls (not just the script's own assertions):
- Issuance flags = allowlist + lockable + clawback-able, not globally frozen.
- A: 500 tokens, unfrozen.
- B: 700 tokens (1000 − 300 clawed back), frozen.
- C: 0 tokens, unauthorized (banned).

`result.json` is written in the project root with the issuance ID and holder addresses. Run it again anytime with `npm run demo` (uses `.env` for `ISSUER_SEED`/`TESTNET_WS_URL`); `npm run build`/`npm run typecheck` compile cleanly.