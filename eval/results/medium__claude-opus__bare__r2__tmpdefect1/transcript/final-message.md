I wrote the project and ran it against testnet. Everything now exists on the ledger. A separate query afterwards confirmed the holder's balance is 1000, the total in circulation is 1000, and the "approved holders only" setting is on.

**`result.json`**
```json
{
  "issuanceId": "01427F54752DE6E9FC24423B4E5EEE01818313445FF99F99",
  "holder": "rH4Vidq6xRyGJhR4gB88xtuGNPgrFTw39R",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

**What the script does** (`src/index.ts`, run with `npm start`; strict type-check with `npm run typecheck`):
1. **Issues the token** from your account (`MPTokenIssuanceCreate`). The "approved holders only" flag (`tfMPTRequireAuth`) is set. I also turned on `tfMPTCanTransfer` so holders can send the token to each other; remove it if you only want transfers to and from you.
2. **Sets up the holder.** It generates a new account and funds it with 10 XRP from your account. The holder then opts in to the token, and your account approves it (both steps are `MPTokenAuthorize`).
3. **Sends the holder 1,000** of the token with a `Payment`.
4. **Reads the balances back** from the latest validated ledger: the holder's balance and the total in circulation.

The script stops with an error if any transaction doesn't return `tesSUCCESS`.

**Things to know:**
- **Your seed isn't in the code.** It's read from `.env` (`XRPL_ISSUER_SEED`), and `.env` is gitignored.
- **The holder account's seed** is saved to `holder-wallet.json`, also gitignored, so you can keep using that account.
- **Each run creates a new token and a new holder**, which costs about 10 XRP per run from your account. It doesn't reuse the ones above.
- **One workaround for an `xrpl` package bug:** version 5.3.0 leaves the holder's token balance entry out of its ledger types, so the code does one explicit type conversion to read it.
- **Nothing is committed to git.** Your repo has no commits yet; tell me if you want me to make one.