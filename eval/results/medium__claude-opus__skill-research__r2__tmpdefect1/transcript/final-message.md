Everything now exists on testnet. The holder has 1,000 of the token, and the total in circulation is 1,000. I checked this with a separate query straight to the ledger, not only through the script.

**`result.json`**
```json
{
  "issuanceId": "01427F78E8A225FD62F7C98B67D38DA5C91FCB28F42F2511",
  "holder": "rNQuWVRS6fGcxKzSSmvUZDQtNqiFRxFs3t",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

The separate query also confirmed that the token only allows approved holders, and that the holder's entry is marked as approved by you.

## What I found in the research
- **`xrpl` package:** the latest version is 5.3.0, from 2026-09-16. Since 5.0.0 there have been a few breaking changes. None of them affect this project, because your seed starts with `sEd` and the key type is worked out from that prefix.
- **Other tools:** TypeScript 7.0.2 and @types/node 26.6.3, both the latest versions.
- **Testnet amendments:** the core MPT amendment (`MPTokensV1`) is enabled. Four related amendments are **not** enabled yet: `DynamicMPT`, `ConfidentialTransfer`, `Sponsor` and `fixCleanup3_4_0`. So the code doesn't use the features that depend on them, such as `ImmutableFlags` or confidential balances.
- **Signing:** version 5.2.0 added new signature formats tied to `fixCleanup3_4_0`. I checked that xrpl.js still signs normal transactions the standard way by default, so the amendment being off on testnet doesn't cause problems.
- **Docs:** I read the xrpl.org pages for `MPTokenIssuanceCreate`, `MPTokenAuthorize`, `Payment`, the `MPTokenIssuance` and `MPToken` ledger objects, and `ledger_entry`.

## What the script does
All of the code is in `src/index.ts`.
1. **Issue the token:** creates it from your account with only approved holders allowed.
2. **Set up the holder:** creates a new account and sends it 5 XRP from yours. The holder then signs up for the token, and you approve it.
3. **Send:** transfers 1,000 of the token from you to the holder.
4. **Read back:** fetches the holder's balance and the total in circulation from the latest confirmed ledger, prints them and writes `result.json`. Each transaction is checked, and the script stops if any of them fails.

## Things to know
- **Your seed isn't in the code.** It's read from an environment variable: `ISSUER_SEED=<seed> npm start`.
- **The holder's seed was printed to the console:** `<TESTNET_SEED_REDACTED>`. That's the only way to control that account, so keep it if you want to use the holder later.
- **Running the script again creates a new token and a new holder.** It doesn't reuse the ones above.
- **Library typing gap:** xrpl.js's type definitions leave out the holder's token entry (`MPToken`). I worked around this by giving the response type explicitly, so the project still builds with strict checks.
- **Nothing is committed.** The files are in the working tree, and `node_modules/` and `dist/` are ignored by git.