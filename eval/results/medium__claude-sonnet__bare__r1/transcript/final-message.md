The code is clean. Everything is in place and verified on-ledger.

## Summary

Created a strict-TypeScript project in `/private/tmp/ws/07f4f4083e6b/project` using `xrpl` 5.3.0:

- `src/index.ts` — connects to `wss://s.altnet.rippletest.net:51233`, then:
  1. Issues an MPT from your account via `MPTokenIssuanceCreate` with `tfMPTRequireAuth` set (holders must be approved).
  2. Funds a fresh holder account from the testnet faucet, has it opt in via `MPTokenAuthorize`, then has the issuer approve it via `MPTokenAuthorize` with `Holder` set.
  3. Sends 1,000 of the MPT via `Payment` with an `{ mpt_issuance_id, value }` amount.
  4. Reads the holder's `MPToken` object and the `MPTokenIssuance` object back via `ledger_entry` and prints/writes the balance and outstanding amount.
- `tsconfig.json` (strict mode), `package.json` (`npm start` builds and runs it), `.gitignore`.

Note: `ts-node` didn't work with the `typescript@^7` that `npm init` pulled in, so I removed it and wired `npm start`/`npm run build` to compile with `tsc` and run the plain JS output instead.

I ran it against testnet — everything above actually exists on the ledger now. Latest run's `result.json`:

```json
{
  "issuanceId": "01426E9DBF123374FE3ED82D01945000B7F9ED3054C8843A",
  "holder": "rhu8pA8k4ZJfZiw1uCbmRdghmAHbB25WTA",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Note I ran the script twice while testing, so there are two separate MPT issuances on testnet from your account now; `result.json` reflects the final run.