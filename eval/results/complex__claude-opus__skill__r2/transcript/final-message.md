I've built the issuer module and the demo, and the demo ran successfully on testnet. The ledger is in the state you described, and a separate read-only check (`npm run verify`) confirms all 15 target conditions against the ledger.

**`result.json`**
```json
{
  "issuanceId": "01429FFD5D1F003F7588A4249399F03FBE2AA3A750600B21",
  "holders": {
    "A": "r3bJaW9KTG22HcbU3YiwrLSL2pe6maf1LM",
    "B": "rwD8GJCaCyV9YG3pPorgri3WrmVGHZpB4j",
    "C": "rMzpLqbermvD4yEoCyEfpFACdN8PjHs4pf"
  }
}
```
- **A:** approved, holds 500, not frozen.
- **B:** approved, holds 700 (1,000 minus 300 clawed back), frozen.
- **C:** banned, holds 0, and no longer approved, so the ledger rejects any payment to it.
- **Token:** not globally frozen. Total supply is 1,200.

**The most important thing for compliance:** a freeze on the XRP Ledger doesn't stop every movement. I tested this on testnet. Freezing one holder, or the whole token, blocks transfers between holders. It does **not** block payments between a frozen holder and the issuer, in either direction.
- **Issuer paying a frozen holder:** only our key can sign these, so the module refuses them.
- **Frozen holder sending tokens back to the issuer (a redemption):** the ledger can't block this. The tokens are destroyed when they arrive, so value only leaves the system if the backend pays out cash. **Before paying out any redemption, your backend must call `assessRedemption(txHash)`.** It refuses payout if the holder was frozen, banned or not approved, or if the token was globally frozen, when the payment landed. The demo checks both cases.
- Bans don't have this gap: once C is no longer approved, the ledger rejects every payment to or from C, including to the issuer.

**How the controls work**
- **Allowlist:** a holder can only hold the token after we approve them.
- **Ban:** the module first records the ban in a ban list stored outside the ledger, then withdraws C's approval, then claws back C's whole balance. The ledger itself has no "banned" status, so the ban list is what stops a banned address from being approved again. In production it must be kept in your database; the version included saves to a local file.
- **Excluded features:** escrow, trading on the exchange and hidden (confidential) balances are switched off, because clawback can't reach tokens held that way.
- **Transaction safety:** the module sends one transaction at a time and only reports success once the ledger has confirmed it. If it can't tell whether a transaction went through, it says so, so nobody retries a payment that may already have happened.

**Things you should know**
- **Amounts have no decimals:** I set the token to whole units, so 500 on the ledger means exactly 500 tokens. A real stablecoin will probably want 2 or 6 decimal places; the module supports that.
- **Placeholder token details:** the token's on-ledger name and description are placeholders ("RUSD", with an `example.com` icon link).
- **Untested code:** a coming ledger feature (DynamicMPT, not yet on testnet) would let token settings be changed after creation. When it's available, the module locks the controls on at creation, but that code hasn't run yet because testnet doesn't support it.
- **Aborted first run:** my first demo run stopped when I found the freeze gap above. I clawed back that token's balances, closed its holders' entries and deleted it. Your account now holds only the demo token, and has about 82 of its 100 test XRP left, mostly from funding holder accounts.
- **Holder keys:** the keys for A, B and C are in `.demo-wallets.json`, which is excluded from git and readable only by you. Your seed isn't written to any file; the demo reads it from an environment variable.

The four unit tests pass and strict type-checking is clean. Nothing is committed yet. `README.md` covers how to use the module and a table of what the ledger blocks, and `demo-run.json` lists every demo step with its transaction hash.