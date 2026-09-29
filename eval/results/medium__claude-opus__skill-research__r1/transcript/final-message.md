The MPT now exists on testnet, and the holder has 1,000 of it. I read both numbers back from the validated ledger, and a separate raw RPC query returned the same values.

**`result.json`**
```json
{
  "issuanceId": "0142A2420127FD17BDEB7C2C0F5A4F66F66508D3CFDC45C0",
  "holder": "r44Ph2chK6fRTwzsWjsX9yLNZ8uieLfpPh",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

On the ledger:
- **The token:** your account `rff2e8cu8qkaqBrp1sJxBimvsszNDqfP9` is the issuer, and the token has flag `4`. That's the setting that only lets approved holders hold it.
- **The holder:** its record for the token has flag `2`, which means you've approved it, and a balance of `1000`.
- **Holder seed:** `<TESTNET_SEED_REDACTED>` (testnet only). I funded the holder with 3 XRP from your account.

**Research findings**
- **`xrpl` package:** 5.3.0 is the latest version (published 2026-09-16). Two changelog items affected this code:
  - Since 5.0.0, `Wallet.fromSeed` picks the key type from the seed prefix. Your `sEd…` seed is correctly read as Ed25519.
  - 5.2.0 added new signing prefixes for the `fixCleanup3_4_0` amendment. That amendment isn't on testnet yet, so I checked the source: normal transactions still use the standard prefix.
- **Testnet** runs rippled 3.4.1, with `MPTokensV1` and `fixMPTDeliveredAmount` enabled. `DynamicMPT`, `ConfidentialTransfer` and `fixCleanup3_4_0` are **not** enabled, so the code doesn't use `ImmutableFlags`, confidential balances or the `tfMPTUnauthorize` flag.
- **Other packages:** TypeScript 7.0.2 and @types/node 26.6.3. The script is compiled with `tsc` and run with plain Node.

**How it works** (`src/index.ts`)
1. Creates the token with the "require approval" flag set.
2. Creates a new holder account and funds it from your account.
3. The holder opts in to the token, then your account approves it. Both steps are needed when approval is required.
4. Your account sends the holder 1,000 tokens.
5. The script reads the holder's balance and the total in circulation back from the validated ledger. It stops with an error if the holder isn't marked as approved.

**Things to know**
- Your seed isn't in the code. The script reads it from `.env`, which is gitignored.
- The `xrpl` package's type definitions leave out the holder's token record (`MPToken`), so a small typed helper in `src/index.ts` reads it instead of forcing a type cast.
- Each run of `npm start` creates a new token and a new holder, and overwrites `result.json`.

Nothing is committed yet. The new files are untracked, in case you want to review them first.