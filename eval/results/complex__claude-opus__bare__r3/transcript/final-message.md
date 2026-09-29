I've built the issuer module and the demo script, and run the demo on testnet with your account as issuer. The final ledger state matches your spec, and I confirmed it separately with a script that reads the ledger directly.

**`result.json`**
```json
{
  "issuanceId": "0142A124F9C85AB27786378530B70D4E4D5665E19A865094",
  "holders": {
    "A": "rneB6ko7rZEJC6ayExErG1vAgrcV6fZToa",
    "B": "r44pVnRqpDRZxA3m4SPRss9fb3zPZzpwiD",
    "C": "r974o58ZXXKAWPtK5aFUaMjesPKq6MkPax"
  }
}
```

**End state on the ledger:**
- **Token:** issued from your account with the allowlist, freeze and clawback controls switched on. It is not globally frozen, and 1,200 are in circulation.
- **A:** approved, holds 500, not frozen.
- **B:** approved, holds 700, frozen.
- **C:** holds 0 and is no longer approved. C is also left frozen as an extra safeguard, and is recorded as banned.

**What the demo checked:** for each control it also tried the actions that should be blocked and confirmed they were:
- sending to a holder who hadn't been approved yet;
- transfers to and from a frozen holder;
- transfers between holders during the global freeze;
- clawing back more than a holder has;
- any way of sending to C after the ban, including a direct payment from your account that skips the module. The ledger itself rejected that one.

The full log with transaction hashes is in `demo-output.log`.

**What's in the directory:**
- **Module (`src/`):** `MptIssuer` has one method per control: `approveHolder`, `issue`, `clawback`, `freezeHolder`, `freezeAll`, `ban`, and so on. Amounts are passed as decimal strings. Every call waits for the ledger to confirm and throws an error if the transaction failed.
- **Scripts:**
  - `npm run demo` runs the demo.
  - `npm run verify` re-checks `result.json` against the ledger.
  - `npm test` runs unit tests for amount handling.
  - `README.md` covers usage.
- **Secrets:** your seed is in `.env`, and the holders' seeds are in `.demo-holders.json`. Both are gitignored. I haven't committed anything.

Before this run I did two practice runs with throwaway issuers from the testnet faucet, so your account has only this one token issuance. Your account paid 15 XRP to fund the three holders, plus small fees.

**Things your compliance team should know.** I tested each of these on testnet:
1. **A freeze on the ledger doesn't stop your own account.** The XRP Ledger still lets the issuer send tokens to a frozen holder, even during a global freeze. It only blocks transfers between holders. The module refuses to issue in both cases, but that protection only holds if every payout goes through the module.
2. **Frozen holders can still send tokens back to you.** The ledger always allows this, and those tokens are destroyed, so no value leaves your control. But your off-ledger redemption process must refuse to pay out fiat to frozen or banned holders.
3. **The ban list is what makes a ban permanent.** The ledger has no "banned" flag. A banned address is simply unapproved, frozen and empty, and it stays unapproved even if the holder deletes and re-creates their token holding. What stops someone at your company from re-approving it later is the module's ban list. The demo keeps that list in a JSON file (`data/bans.json`); in production it should live in the same database as your KYC decisions.
4. **The token's settings are locked in and deliberately restrictive.** The allowlist, freeze and clawback settings can't be changed now that the token exists. I left escrow, DEX/AMM trading and confidential balances turned off, because tokens held there could be out of reach of clawback. Turning them on later would mean issuing a new token.
5. **The token uses whole units for now.** I created it with 0 decimal places so "500 tokens" is exactly 500 on the ledger. For production you'll probably want 2 or 6. The module supports that, but the setting can't be changed after the token is created.