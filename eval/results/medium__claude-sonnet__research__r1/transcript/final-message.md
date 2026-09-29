The script and its output look correct. Everything succeeded end-to-end.

## Summary

**Research done first:**
- `xrpl` npm latest is **5.3.0** — MPT support (XLS-33) landed in 4.1.0 and matured through 4.4.0/5.1.0 with metadata helpers and Dynamic MPT support.
- Read the xrpl.org docs for `MPTokenIssuanceCreate`, `MPTokenAuthorize`, `Payment` (MPT amount format), and the `MPTokenIssuance`/`MPToken` ledger objects; confirmed via the actual `.ts` source shipped in the installed package that field names/casing matched (`MPTokenIssuanceID`, `mpt_issuance_id`, `MPTAmount`, `OutstandingAmount`, etc.).
- Queried the testnet server directly (`feature` RPC on `s.altnet.rippletest.net:51234`) and confirmed **`MPTokensV1` is enabled** (so MPTs work) and `DynamicMPT` is disabled (so I avoided `ImmutableFlags`).
- Used latest TypeScript (7.0.2) and `@types/node` (26.6.3). Note: `ts-node` doesn't yet support TS7's restructured internals, so I dropped it and run via plain `tsc` + `node` instead — simpler and doesn't need a workaround.

**Project** (`/private/tmp/ws/a07342828b53/project`): strict-mode TypeScript project (`src/index.ts`) that:
1. Issues an MPT from your account with `tfMPTRequireAuth` (allow-listing only).
2. Funds a fresh testnet holder account via the faucet, has it opt in, then issuer-approves it via `MPTokenAuthorize`.
3. Sends 1,000 units via a `Payment` with an MPT amount.
4. Reads the holder's balance and outstanding supply back via `ledger_entry` (`mptoken` / `mpt_issuance`).

Ran it live against testnet — result:
```json
{
  "issuanceId": "01427F7C987D32441ED0587A5BB401FEEB9D127CF20E8D21",
  "holder": "rpnU1rCShwVVpR78DDkSTykwKypFban9pS",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```
`result.json` is written in the project directory. Run with `npm start` (builds then executes).