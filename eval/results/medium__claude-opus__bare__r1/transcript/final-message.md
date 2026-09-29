The script ran on testnet and all four steps are on the ledger. I read the ledger again separately afterwards: the holder has 1000 of the token and 1000 are in circulation.

**`result.json`**
```json
{
  "issuanceId": "0142A1E0916B77D3370B7E834813E7B3793DB1418C7BDB72",
  "holder": "rEJm1fub9VgnwgtyArNvgAvELYvk41F3Ht",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

**What the script (`src/index.ts`) does:**
1. **Creates the token** from your account with the "require authorization" flag, so only holders you approve can hold it.
2. **Sets up the holder.** It creates a new account and sends it 5 test XRP from yours. The holder then opts in to the token, and your account approves it.
3. **Sends the holder 1000 tokens** from your account.
4. **Reads the balances back** from the latest confirmed ledger, prints them, and writes `result.json`.

The separate check also confirmed the token requires authorization and the holder is marked as approved.

**Things to know:**
- **Your seed isn't in the code.** The script reads it from an environment variable: `XRPL_ISSUER_SEED=sEd... npm start`.
- **The holder's seed is in `holder-wallet.json`**, so you can still use that account. The file is in `.gitignore`.
- **Each run creates a new token and a new holder.** It costs a little of your test XRP each time.
- **Holders can't send the token to each other.** I only set the flag you asked for, so tokens can move only between you and your holders. If you want holders to trade among themselves, add the `tfMPTCanTransfer` flag when creating the token. Flags can't be changed after the token exists.
- **Nothing is committed.** The files are in the working tree.