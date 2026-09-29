The MPT now exists on testnet: the holder is approved and holds 1,000 tokens, and 1,000 are in circulation. `result.json` contains:

```json
{
  "issuanceId": "0142A2338C72510C958E5968CFF425C17A053DDBF7F576CF",
  "holder": "rpgmnNuDnG7uNDjvV3kEEmbhwQb58N7jLP",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

I checked this with a separate direct query to the ledger. The token is set so only approved holders can have it, and the holder's entry is marked as approved.

**Research that affected the code**
- **xrpl version:** the latest on npm is 5.3.0 (released 2026-09-16). Since 5.0.0, the library works out the key type from the seed. I set it explicitly to ed25519 for your `sEd…` seed, as the changelog recommends, and the script checks that the seed produces your address.
- **Docs:** I read the xrpl.org pages for `MPTokenIssuanceCreate`, `MPTokenAuthorize` and `Payment`, and for the `MPTokenIssuance` and `MPToken` ledger entries.
- **Testnet amendments:** testnet runs rippled 3.4.1. `MPTokensV1` is enabled, but `DynamicMPT`, `ConfidentialTransfer`, `Sponsor` and `fixCleanup3_4_0` are not. So I didn't use `ImmutableFlags` or any of the newer MPT features in the docs, because they would fail on testnet.

**What the script does** (`src/main.ts`):
1. Creates the token with the "require approval" flag. It has no decimal places, so 1000 means 1,000 whole tokens.
2. Creates a new holder account and sends it 10 XRP from your account. The holder signs up for the token, then your account approves it.
3. Sends the holder 1,000 tokens.
4. Reads the holder's balance and the total in circulation from the latest confirmed ledger. It stops with an error if the approval settings aren't set, and writes `result.json`.

**Project setup:** strict TypeScript, with typescript 7.0.2, @types/node 26.6.3 and xrpl 5.3.0. It compiles with `tsc` and runs with plain `node`. I dropped `tsx` because it needed an install script I didn't want to approve for you.

**Things to know:**
- Your seed isn't in any file. The script reads it from an environment variable:
  ```
  ISSUER_SEED=sEd… ISSUER_ADDRESS=rDocY5L6tZLzkVU2Q1nxpEDbnmgE88ENbZ npm start
  ```
  (`ISSUER_ADDRESS` is optional and only double-checks the seed.)
- Each run creates a new token and a new holder account, and uses about 10 XRP of your test funds.
- The holder's seed (`<TESTNET_SEED_REDACTED>`) was only printed to the console, not saved. It's a testnet account, and you'll need the seed if you want to use it later.
- Nothing has been committed to git.