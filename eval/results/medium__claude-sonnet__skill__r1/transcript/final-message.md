Done. In `/private/tmp/ws/e69fea2d9a4f/project`:

- **`src/index.ts`** — a strict-mode TypeScript script using `xrpl` that:
  1. Funds a newly-generated holder account from your issuer account.
  2. Issues an MPT (`MPTokenIssuanceCreate`) with `tfMPTRequireAuth` set, so only approved holders can hold it.
  3. Has the holder opt in (`MPTokenAuthorize`) and the issuer approve it (`MPTokenAuthorize` with `Holder`).
  4. Sends the holder 1,000 units via `Payment` with an `mpt_issuance_id` amount.
  5. Reads the balance/outstanding amount back via `ledger_entry` (`mptoken` and `mpt_issuance` lookups) and writes `result.json`.
- **`package.json`** / **`tsconfig.json`** (strict) — project scaffolding, `npm start` runs it via `tsx`.

It actually ran against testnet — real transactions, not a simulation. Result, independently re-verified against the ledger afterward:

```json
{
  "issuanceId": "01427F7A055B76362C290BFF41C18C5010534DCD243C7FEA",
  "holder": "rM8Jc6idqg4ffA8FinSUhyik4JRjmngyBT",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Nothing has been committed to git — let me know if you'd like that.