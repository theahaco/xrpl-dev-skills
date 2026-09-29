Done. The project ran end-to-end against XRPL testnet:

- **Issuer** (your account `rfF4z...bFYfg`) created an MPT via `MPTokenIssuanceCreate` with `tfMPTRequireAuth` set, so only issuer-approved holders can hold it.
- **Holder** account `r476JtZEQdkTfsdTUDRJ2FfKRMZQvcAxfk` was created and funded from the testnet faucet, opted in with `MPTokenAuthorize`, and was then approved by the issuer (also `MPTokenAuthorize`, with `Holder` set).
- Issuer sent 1,000 units via a `Payment` with an `mpt_issuance_id` amount.
- Balances were read back from the ledger via `ledger_entry` (`mptoken` and `mpt_issuance`), confirming holder balance = 1000 and outstanding amount = 1000.

Files: `package.json`, `tsconfig.json` (strict mode), `src/index.ts`, and `result.json` (written with real on-ledger values):

```json
{
  "issuanceId": "01427FB84AC6A8ACB9BE2FEF04641A769783457E5B28C76B",
  "holder": "r476JtZEQdkTfsdTUDRJ2FfKRMZQvcAxfk",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Run it again anytime with `npm run run` (build + start). Note: since `MaximumAmount` fixes the issuance ceiling and the account/issuance are already created, re-running will create a *new* MPT issuance and a new holder account each time (not idempotent) — that matches the one-shot nature of the request.