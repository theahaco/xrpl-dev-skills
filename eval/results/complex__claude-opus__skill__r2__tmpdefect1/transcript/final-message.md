I've built the issuer module and the demo script, and run the demo against testnet. It passed every check, and your account now holds the token with the end state you described. `result.json` is written:

```json
{
  "issuanceId": "014278CABED0B84AA99803799883544F6E31DE2E5C20F3CB",
  "holders": {
    "A": "r4NTZeEmhTGWPbpgQcufP6SLKLV1LdfRFW",
    "B": "rQahexUC143WSJ8RpnNuffS9pMPqmHRF3J",
    "C": "rEk7SWwFAz9nP2f2Duz2CXhsomNjHRqiJ6"
  }
}
```

**End state (read back from the ledger at the end of the run):**

| | Approved | Frozen | Balance |
|---|---|---|---|
| A | yes | no (frozen, then unfrozen) | 500 |
| B | yes | yes | 700 (sent 1,000, 300 clawed back) |
| C | no (approval removed by the ban) | yes | 0 (sent 250, then banned) |

The token has all the controls switched on, is not globally frozen (it was frozen and unfrozen during the run), and 1,200 are in circulation.

**The demo also tried each blocked action on the ledger and confirmed it failed:**
- Sending to a holder before approval was rejected.
- Transfers during the global freeze, and to or from a frozen holder, were rejected.
- Payments to or from C after the ban were rejected.
- The module itself refuses to re-approve C, send C tokens or unfreeze C, without sending anything to the ledger.

**How the module works (`src/issuer.ts`):**
- **Settings are permanent.** On testnet, a token's settings can't be changed after it's created. The module only works with a token that has every control switched on. It also refuses tokens that allow escrow or exchange trading, because escrowed tokens can't be clawed back.
- **How a ban works.** The module records the ban, freezes the holder, removes their approval and claws back their whole balance, then checks the result. It is safe to call again if it fails partway. Removing approval is what stops the ledger delivering to that address, even if the holder deletes and recreates their token holding. The ledger can't stop us from re-approving them by mistake, so a stored ban list does that.
- **Results are confirmed.** Each action returns only once the ledger has finalised it as successful, and throws an error otherwise. Actions from the issuer account run one at a time, so parallel calls from your backend can't collide.

**Things you should know:**
- **An earlier failed run.** My first run failed on one assertion: I had guessed the wrong rejection code for C sending tokens after the ban. The transfer was still correctly blocked. That run had left a second, half-finished token on your account. I clawed its tokens back and deleted it, so your account now holds only the token above.
- **Token units.** The demo token has 0 decimal places, so "500" means 500 whole tokens. A real stablecoin needs its decimal places chosen before creation (usually 2 or 6), because this can't be changed later.
- **Before production:**
  - Move the ban list out of the JSON file (`data/bans.json`) into your KYC database.
  - Keep the issuer seed in a secrets manager rather than `.env`.
- **Secrets.** Your seed is in `.env`, and the holder seeds and ban list are in `data/`; all of these are excluded from git. I haven't committed anything.

`README.md` covers the design, and `npm run demo` re-runs the demo. Each run creates a new token and new holders, and overwrites `result.json`.