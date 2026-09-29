Done. Everything ran live against testnet:

- **Issuer** (your account) created an MPT via `MPTokenIssuanceCreate` with `tfMPTRequireAuth` set, so only holders the issuer explicitly approves can hold it.
- A new holder account `rQp9373NiaLnYkuAy44ASpkwyxSJQ16biD` was generated and funded from the testnet faucet.
- Holder opted in and issuer approved it via `MPTokenAuthorize` (both directions).
- Issuer sent 1,000 units via a `Payment` with an `mpt_issuance_id` amount.
- Balances were read back from the ledger with `ledger_entry` (`mptoken` for the holder's balance, `mpt_issuance` for `OutstandingAmount`) — both confirm 1,000.

Files in `/private/tmp/ws/04ef7645b319/project`:
- `package.json`, `tsconfig.json` (strict mode) — `xrpl` as the only runtime dependency
- `src/index.ts` — the full script
- `result.json` — the requested output:
```json
{
  "issuanceId": "0142A5221B289F06F35AE75FB0652D3923A7264589A0061B",
  "holder": "rQp9373NiaLnYkuAy44ASpkwyxSJQ16biD",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Note: the holder's seed isn't persisted anywhere — it only exists in that one run's memory, since it wasn't requested. Let me know if you'd like it saved for further experimentation.