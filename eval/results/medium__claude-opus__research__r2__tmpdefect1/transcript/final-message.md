The token now exists on testnet: I issued it from your account, set up and approved a holder, sent it 1,000, and read the balances back from the ledger. I then queried the ledger separately and got the same numbers.

`result.json`:
```json
{
  "issuanceId": "01427F78B52EE310ED0FFC44327E1654B90CAAE54425515F",
  "holder": "rfTQF3eaHv76JttG3hSq4QuX6JioXwmYn7",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

On the ledger, the token has the "only approved holders" flag set and the holder's entry is marked as approved by you, both on validated ledgers.

**Research findings:**
- **xrpl package:** the newest stable version is 5.3.0 (released 2026-09-16), which the project uses. From the changelog, the change that matters here is from 5.0.0: the key type is now worked out from the seed's prefix. Your seed starts with `sEd`, and the code states the key type explicitly anyway.
- **Docs:** I read the xrpl.org pages for the three transaction types used (MPTokenIssuanceCreate, MPTokenAuthorize and Payment, including its MPT section) and the two ledger objects (MPTokenIssuance and MPToken).
- **Testnet amendments:** MPTokensV1, which MPTs need, is enabled. DynamicMPT, Sponsor and fixCleanup3_4_0 are not, so the code avoids the features they add.
- **Other tools:** TypeScript 7.0.2, tsx 4.23.15 and @types/node 26.6.3, all the latest versions.

**How it works** (`src/index.ts`):
1. **Issue:** creates the token with only the "require approval" option set. Transfers between holders, clawback and so on are left off.
2. **Holder:** creates a fresh account, funds it with 5 XRP from yours, has it opt in to the token, then approves it from your account.
3. **Send:** pays the holder 1,000 of the token.
4. **Read back:** reads the holder's balance and the total in circulation from the latest validated ledger, prints them and writes `result.json`.

It stops with an error if any transaction doesn't succeed. Run it with `npm start`; `npm run typecheck` checks the types under strict mode. Each run issues a new token and creates a new holder.

**Things to know:**
- **Your seed is in `.env`, not in the code.** That file is listed in `.gitignore` so it won't be committed, and `.env.example` shows the format.
- **The holder's seed** was printed to the console during the run: `<TESTNET_SEED_REDACTED>`. Keep it if you want to use that account again; it isn't saved anywhere else.
- **One workaround in the code:** xrpl 5.3.0's type definitions leave out the holder's token entry when reading from the ledger. I told TypeScript the expected type directly, and the code still checks what actually comes back.
- **One install step skipped:** npm held back esbuild's install script, which tsx depends on. I didn't approve it because tsx works without it.

Nothing is committed yet.