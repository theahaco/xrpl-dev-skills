The issuer module and demo are built, and the demo ran against testnet from your account and passed all its checks. I also read the ledger directly afterwards and it matches what you asked for:

| | Balance | Approved | Frozen |
|---|---|---|---|
| A `rB2QBYJ28t9spsRp4Ni1WSJdHYri35btu6` | 500 | yes | no (frozen, then unfrozen) |
| B `rDAzU8SuEbg8NRdvnrgS1QbtwRxgXg96So` | 700 (1,000 sent, 300 clawed back) | yes | yes |
| C `rDXuaQtKqE8ZKa6dw3ycQsSFLk2PRUEhHY` | 0 (was sent 250) | no, banned | yes |

- **Token:** issuance `014278B4BCDF648387A31575B5C5921D58BF7FB9068E84BA`, from your account. It's the only object on your account.
- **Global freeze:** the token was frozen and unfrozen during the demo, and is not frozen now. 1,200 tokens are in circulation.
- **`result.json`** is written in the format you gave.
- **Permanent controls:** the token has freeze, allowlist, clawback and holder-to-holder transfers turned on. Testnet doesn't allow these settings to change after creation. Escrow, DEX trading and confidential balances are off, because tokens held there would be out of reach of clawback and freeze.

The demo also tries each forbidden action and confirms it fails. For example, it pays a frozen holder, sends to a banned holder, and re-approves a banned holder.

**Things your compliance team needs to know.** I first tested on throwaway testnet accounts and found two gaps in what the ledger enforces:
1. **Freezes don't stop the issuer.** The ledger lets the issuer pay a frozen holder, and pay anyone during a global freeze. The module's `issue()` checks for this and refuses, but anything else that signs with the issuer key bypasses that check.
2. **Frozen holders can still send tokens back to the issuer.** This is how the ledger works and we can't block it. Transfers between holders are blocked.
3. **Bans depend on our own ban list.** The ledger has no native ban. After a ban, the address holds nothing and can't receive, even if it removes and re-adds the token (I tested that). What stops it being approved again is the module's ban list, which lives in a local file for now. In production it must go in your main database. There's deliberately no "unban".

**Decisions before mainnet:**
- **Decimal places:** the demo uses whole-token units, so on-ledger amounts equal token amounts. A stablecoin probably wants 2 or 6 decimals, and this can't be changed after creation.
- **Issuer key storage:** your seed is in `.env`, which git ignores. On mainnet the key belongs in an HSM or key-management service.
- **One issuer process:** issuer transactions are handled in order inside one process, so run only one instance per issuer account.

Other details:
- A transaction call only returns once the result is final on the ledger. After a dropped connection it doesn't resubmit, so a retry can't pay twice.
- Every action is written to an audit log, including failed and refused ones.
- The three holders' seeds are in `.demo-secrets.json`, which git ignores.
- The demo used about 15 XRP of your balance to fund the holders, plus small fees.
- I haven't committed anything.

The module is in `src/`, starting from `src/issuer.ts`; the demo is `src/demo.ts` and runs with `npm run demo`. `README.md` has the design notes.