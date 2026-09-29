The issuer module and demo are built, and the demo ran against testnet from your account. A separate verification script re-checked every item of the end state you listed on the ledger, and all passed. TypeScript strict mode compiles cleanly and the 10 unit tests pass.

**`result.json`**
```json
{
  "issuanceId": "01429FE7EBBB5754775E4CABDE50826E3EAFD2EDDB0395DA",
  "holders": {
    "A": "rKLNoo8RjpEeWAToYKyBQCZnV5JJgKjy6c",
    "B": "raDmSzETNamgHhBgh63ULDVFxyiZF27dzA",
    "C": "rHhBqdQTRHpwT5XzqjhGYDAdh5d6DzWC6c"
  }
}
```

End state: A is approved, holds 500 and is not frozen. B is approved, holds 700 and is frozen. C holds 0, is off the allowlist and is on the ban list. The token is not globally frozen, and 1,200 tokens are in circulation. Your account has exactly this one token issuance; before touching it I rehearsed the whole demo twice on a throwaway account.

The demo checks that the ledger actually rejects what each control should block:
- **Allowlist:** a payment to an unapproved holder fails.
- **Freezes:** transfers to or from a frozen holder fail, and all holder-to-holder transfers fail during a global freeze.
- **Ban:** payments to C fail afterwards. This still holds after C deletes and re-creates its token holding.

The main code is in `src/issuer.ts`, and `README.md` explains how each control maps to the ledger.

**Decision for your compliance team: frozen holders can still pay the token back to you.** On the XRP Ledger, a freeze (per-holder or global) does not block a holder sending the token back to the issuer. Only transfers between holders and new issuance are blocked. I confirmed this on testnet and could not find a setting in the module that changes it. The tokens do leave circulation, but your off-ledger redemption process must not pay out for tokens received while the holder or the token was frozen. The demo shows this openly: during the global freeze, C sent 1 token back to your account. So C was sent 250, returned 1, and the ban clawed back the remaining 249. Removing a holder from the allowlist does block these returns, so a ban does that before clawing back.

**Other decisions to review:**
- **No decimals:** the token uses whole units, so "500" on the ledger means 500 tokens. A stablecoin usually wants 2 decimals, but then A's ledger balance would read 50000. The number of decimals is a setting, but it's fixed once a token is created.
- **Some features are permanently off:** escrow, DEX/AMM trading and confidential balances are disabled, because each lets tokens sit where clawback can't reach them. The module also refuses to manage a token that has them turned on. These settings can't be changed after creation on testnet, so turning them on would need a new token.
- **Holder transfers are on:** holders can send the token to each other.
- **Your backend must keep the ban list.** On the ledger, a banned holder can't receive the token again. The one thing that could undo a ban is you re-approving the address, so the module refuses to approve, issue to, or unfreeze anyone on the ban list. The list is stored in a JSON file for the demo; in production it should live in the same database as your KYC decisions.
- **Placeholder token details:** the name, ticker and icon (e.g. `DUSD`) are placeholders.
- **One instance per issuer account:** the module handles one operation at a time, so run only one copy of it for your issuer account.

**Local files and costs:**
- Your seed is in `.env`.
- The holder seeds, the ban list and an audit log are in `.data/`.

Both `.env` and `.data/` are git-ignored. Nothing has been committed. The demo used about 15 XRP from your account, mostly the 5 XRP given to each holder; you have about 85 XRP left.