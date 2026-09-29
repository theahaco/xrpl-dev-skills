I've built the issuer module and the demo, and run it on testnet. The ledger is now in the state you asked for, and `result.json` is written. I checked the final state twice: once through the module and once by reading the raw ledger objects directly.

**Result (issuance `014278DA65068CD39D58A4C8DBC03E0BB731B9AC967D3124`)**

| | Address | Balance | Approved | Frozen |
|---|---|---|---|---|
| A | rNyrpRDR9FALctJVq6BmtQg776GdEi62y5 | 500 | yes | no (frozen, then unfrozen) |
| B | rNzmuqamgPLbQFE3UTYpvVcMszw9MxmcTU | 700 (1,000 sent, 300 clawed back) | yes | yes |
| C | rHmpUYMpYAUXzeyPRKGF4ReApQR3fXQXUc | 0 (250 clawed back by the ban) | no | yes, and banned |

The token was globally frozen and then unfrozen, and 1,200 is outstanding. Your account holds only this one issuance.

For each control, the demo checked both sides: the allowed action works, and the forbidden one is blocked. Some are blocked by the ledger (e.g. `tecNO_AUTH`, `tecLOCKED`) and some by the module before anything is submitted. The 22 unit tests pass and the strict-mode typecheck is clean.

**What your compliance team should know:**
- **Freezes don't stop payments to and from your account.** I checked this on testnet: a frozen holder, or any holder during a global freeze, can still send tokens back to you, and you can still pay them. Only transfers between holders are blocked. The module refuses to issue to frozen holders or during a global freeze. It can't stop a frozen holder sending tokens back to you; to block that too, you have to revoke their approval.
- **The ledger has no "banned" status, so bans rely partly on a record we keep.** A ban records the address first, then freezes the holder, removes their approval, claws back everything, and checks the result. A holder without approval can't send or receive at all, not even to you. The record stops your backend from ever approving that address again after KYC. The demo stores it in a JSON file; in production it should live in your compliance database.
- **Some token features are permanently off.** Escrow, DEX trading and confidential balances are all disabled, because balances held there would be out of reach of clawback and bans. The module also refuses to operate an issuance with a permissioned domain (`DomainID`) set, because domain credentials would bypass the allowlist. On testnet today these settings can't be changed after creation. When `DynamicMPT` goes live they become changeable, so the module will also lock them at creation.
- **One process per issuing key.** Parallel processes signing with the same key will clash on transaction sequence numbers.

**Choices you may want to change:**
- **Whole-token amounts:** the token uses 0 decimal places, so "500" is exactly 500 on the ledger. For cents, set `assetScale: 2`; amounts in the API are then in hundredths.
- **Placeholder metadata:** ticker `DUSD`, and the icon URL is a placeholder on `example.com`.

**Housekeeping:**
- **Where your seed is:** in `.env`, which is excluded from git. The holder keys are in `holders.1790652905069.local.json`.
- **First demo run:** it stopped halfway because of a bug in how I submitted transactions, which I fixed. I then clawed back its 1,500 tokens and deleted its issuance.
- **Leftover testnet accounts:** that first run's three holder accounts (15 test XRP) remain. Their keys are in `abandoned-run-holders.local.json`, and most of that XRP can be recovered by deleting the accounts later. Two probe accounts I used to test ledger behaviour (about 6 test XRP) can't be recovered because I didn't keep their keys.
- **Balance:** your account went from 100 to about 64 test XRP in total.

Nothing is committed. Run `npm run demo` to reproduce from scratch; each run uses about 15 test XRP. The README covers the API, errors and design decisions.