The script ran against testnet and everything is now on the ledger. I checked it again afterwards with a separate query.

**`result.json`**
```json
{
  "issuanceId": "0142A25564C81D8A539C1EA0DD9A5F137645A01EF5D241A1",
  "holder": "rDeP7Ws9EYruruRf7ZejYe3tMrXVakNQph",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

**What the script does** (`src/index.ts`, TypeScript strict mode, `xrpl` 5.3.0):
1. **Creates the token** from your account with the `tfMPTRequireAuth` flag, so only holders you approve can hold it.
2. **Sets up the holder:** makes a new account and sends it 10 XRP from yours. The holder then opts in to the token, and your account approves it.
3. **Sends 1,000 of the token** to the holder.
4. **Reads the balances back** from the latest validated ledger. The holder's balance is 1000 and the total in circulation is 1000.

Each transaction waits until it's validated and stops with an error if the result isn't `tesSUCCESS`. All five succeeded. On the separate check, the token has the approval-required flag set, and the holder's entry shows it was approved with a balance of 1000.

**Running it:**
```sh
npm install
XRPL_ISSUER_SEED=<your seed> npm start
```

- **Your seed isn't in the code.** It's read from the `XRPL_ISSUER_SEED` environment variable, so it can't end up in git by accident.
- **The holder's seed is in `holder-wallet.json`,** so you can still use that account. The file is excluded from git.
- **Each run creates a new token and a new holder account,** and moves about 10 XRP out of your account.

I haven't made any git commits.