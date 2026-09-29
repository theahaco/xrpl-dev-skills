The token now exists on testnet. Your account issued it with approval required, the new holder account was approved and received 1,000 tokens, and reading the ledger back shows those amounts. I also checked the ledger separately from the script, and it agrees.

**`result.json`**
```json
{
  "issuanceId": "0142A271B06A3A6B4CF86D4225FCB34138A9D8C3116A6F40",
  "holder": "rL9oN7tcSobKnHLsdRHCnwskYevxLW4To8",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

**What the run did** (every transaction was confirmed by the ledger with `tesSUCCESS`):
1. **Issued the token** (`MPTokenIssuanceCreate`) with the `tfMPTRequireAuth` flag, so only approved holders can hold it. The ledger shows the flag is set (`Flags: 4`).
2. **Set up the holder:**
   - Created a new account and funded it with 2.4 XRP from yours. That covers the account's required XRP reserve, the reserve for holding the token, and fees.
   - The holder opted in to the token.
   - Your account then approved it. The holder's entry on the ledger is marked as approved (`Flags: 2`).
3. **Sent 1,000 tokens** with a `Payment`.
4. **Read both balances back** from the latest confirmed ledger: the holder's balance and the total in circulation (`OutstandingAmount`).

**Project layout**
- `src/index.ts`: the script, which uses `xrpl@5.3.0`.
- `tsconfig.json`: strict mode is on.
- `package.json`: `npm start` runs the script and `npm run typecheck` checks the types (it passes cleanly).

**Things to know**
- **Your seed isn't stored anywhere in the project.** The script reads it from an environment variable, so run it as `XRPL_SEED=sEd… npm start`.
- **Each run creates a new token and a new holder account.** It also rewrites `result.json`, so running it again will replace the IDs above.
- **The holder's seed is saved in `holder-wallet.json`**, readable only by you and excluded from git. Without it you couldn't use that account again.
- **I set the token's decimal places (`AssetScale`) to 0.** That means "1000" is exactly 1,000 whole tokens. Token amounts on the ledger are always whole numbers of the smallest unit, so with 2 decimal places, 1,000 tokens would have to be sent as "100000".
- **Nothing is committed yet.** I haven't made a commit, so tell me if you'd like one.