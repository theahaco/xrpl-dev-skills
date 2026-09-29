I ran it on testnet and everything now exists on the ledger. I also checked the result against a second testnet endpoint, and it matches.

**What I found before writing code**
- **xrpl**: the latest stable version is 5.3.0, released 2026-09-16. One change that matters here: since 5.0.0, `Wallet.fromSeed` works out the key type from the seed itself. I confirmed your `sEd…` seed gives your address `rBGqg6…9e4`.
- **Docs**: I read the xrpl.org pages for MPTokenIssuanceCreate, MPTokenAuthorize, Payment (including its MPT payments section), and the MPTokenIssuance and MPToken ledger entries.
- **Testnet** (rippled 3.4.1): `MPTokensV1` is enabled. `DynamicMPT` is **not** enabled yet, so the script doesn't use the new `ImmutableFlags` field, which would be rejected there.
- **Other tools**: TypeScript 7.0.2 and @types/node 26.6.3. Node 24 can run TypeScript directly, so `tsc` only type-checks (strict mode) and nothing else is needed to run the script.

**What the script does** (`src/index.ts`)
1. Creates the token with the "require authorization" setting on, so only holders you approve can hold it.
2. Creates a new holder account and funds it with 5 XRP from your account. The holder opts in to the token, then your account approves it.
3. Pays the holder 1,000 of the token.
4. Reads the holder's balance and the total in circulation back from the latest validated ledger, prints them and writes `result.json`.

It stops with an error if any transaction doesn't succeed.

**On the ledger now**
```json
{
  "issuanceId": "0142A27770B02317CFD486A0D02F4761608DEA8585A8BE8D",
  "holder": "rP3uTbcJudtCRg7UCAkanDAiDhLtEVvcoT",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

**Things to know**
- **Seed handling:** your seed isn't in the code. The script reads it from the `XRPL_ISSUER_SEED` environment variable.
- **Holder seed:** the new holder's seed is saved to `holder-wallet.json`, which is gitignored, so you can keep using that account.
- **Re-running:** each run of `npm start` creates a brand-new token and holder rather than reusing these.
- **Library gap:** xrpl 5.3.0's type definitions leave `MPToken` out of their list of ledger entry types. I worked around it by stating the response types explicitly instead of casting.

To run it again: `XRPL_ISSUER_SEED=sEd… npm start`. To type-check: `npm run typecheck`. I haven't committed anything.