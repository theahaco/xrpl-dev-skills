Everything is live on testnet, and `result.json` is written:

```json
{
  "issuanceId": "0142A282C80747645602A0CCF6597AA0621143E3008ED453",
  "holder": "rhsEb5Y7LGPCQ5dELVoitVKpR7aPJEaE6Q",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

All five transactions returned `tesSUCCESS` in validated ledgers. I then checked the ledger separately: the token has the "require approval" flag set, the holder is marked as approved and holds 1000, and the total in circulation is 1000.

**Research findings**
- **`xrpl` package:** 5.3.0 is the latest stable release (5.4.0 exists only as an experimental "smartescrow" build). One 5.x change mattered here: `Wallet.fromSeed` now works out the key type from the seed. Your seed starts with `sEd`, so it gets the correct key type automatically.
- **Testnet amendments:** `MPTokensV1` is enabled, which is all this needs. `DynamicMPT`, `ConfidentialTransfer` and `fixCleanup3_4_0` are supported but **not enabled**, so I left out anything that depends on them (such as making token settings permanent).
- **Reserves:** testnet currently requires 1 XRP per account plus 0.2 XRP per ledger object. The bundled xrpl-dev skill says 10 XRP / 2 XRP, which is out of date. Its MPT example also leaves out the flag that restricts holders to approved accounts.
- **Docs read on xrpl.org:** the token creation, holder approval and payment transaction pages, plus the two ledger entries that hold the token's supply and each holder's balance.

**What the script (`src/index.ts`) does**
1. Creates the token with only the "require approval" flag set. Holders can't pass it to each other, since you didn't ask for that.
2. Creates a new holder account and sends it 5 XRP from your account.
3. Has the holder opt in to the token, then has your account approve the holder.
4. Sends the holder 1,000 of the token.
5. Reads both balances back from the latest validated ledger and writes `result.json`.

**Files and running it**
- The project uses strict TypeScript 7.0.2, tsx 4.23.15 and `@types/node` 26.6.3. `npm run typecheck` passes.
- Your seed is kept in `.env` rather than in the code. The new holder's seed is saved to `holder-wallet.json`. Both files are gitignored.
- Running `npm start` again creates a **new** token and a new holder each time, costing roughly 5.2 XRP per run.

I didn't test that an unapproved account is actually refused the token. The flag is confirmed on the ledger, but proving it would mean creating and funding another throwaway account. Nothing has been committed.