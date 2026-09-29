I built the issuer module and the demo, and ran the demo against testnet from your account. It passed every check, and I confirmed the final ledger state separately by reading the raw ledger entries without going through the module. `result.json` is written:

```json
{
  "issuanceId": "014278B1D1B069201ECF3D2FDEF0A4B9BF5F083F577AF3F6",
  "holders": {
    "A": "r47YR5jRbkn3y4xiSbd4UuR5yvm4XZd7FG",
    "B": "rGPrqR3uSFT8mUchm5ckyHp4trsYPAVgSf",
    "C": "rMNVSRY7ZghPLLAcn1EUXEbun1W9f8tNje"
  }
}
```

**Final state on the ledger:**

| | Balance | Approved | Frozen |
|---|---|---|---|
| A | 500 | yes | no |
| B | 700 | yes | yes |
| C | 0 (banned) | no | yes |

- The token is issued from `rLfjZKWd…`, with allowlist, freeze, clawback and transfer all enabled.
- The global freeze was applied, shown to block transfers, then lifted, so the token is not globally frozen now.
- The demo used about 15 XRP from your account (5 XRP to set up each holder account) plus fees. It has 84.999772 XRP left.

**Research findings that shaped the design:**
- **Versions:** I'm using `xrpl` 5.3.0, the latest, pinned to that exact version. Version 5 now works out the key type from the seed, so the code explicitly loads your `sEd…` seed as an ed25519 key, as the changelog recommends. TypeScript is 7.0.2 and tsx is 4.23.15.
- **Amendments:** testnet has `MPTokensV1` enabled, which is all this needs. Two alternatives aren't available there, so I didn't use them:
  - `DynamicMPT` is off, so the token's capabilities are fixed when it's created.
  - Allowlisting through a permissioned domain would also need `SingleAssetVault`, which is off.

**Things your compliance team needs to know:**
1. **The ledger doesn't stop the issuer paying a frozen holder.** I tested this: payments from the issuer went through both to a frozen holder and during a global freeze, which contradicts the docs. The module refuses to issue in either case, so all issuer payments must go through it.
2. **A frozen holder can still send tokens back to the issuer.** The protocol always allows this and it can't be switched off. A frozen holder can't send to anyone else or receive from anyone.
3. **Bans depend on a ban list kept outside the ledger.** If a banned holder has a zero balance, they can delete their token entry and open a fresh one, which clears the freeze. The fresh entry isn't approved, so it still can't receive anything; I confirmed this on testnet. But the ledger has no record of the ban, so the module checks its ban list before every approval and issuance. For production, your backend needs to store that list in its database; the file-based version I wrote is for the demo only.
4. **Amounts use 2 decimal places.** The raw on-ledger balances are therefore 50000 for A and 70000 for B, which mean 500.00 and 700.00. The module's methods take normal amounts like `"12.50"`.
5. **Run only one instance of the module per issuer account.** Calls are queued one at a time within an instance, but two instances would compete for the account's transaction sequence numbers.

The module is in `src/issuer/` and the demo is `src/demo.ts`; `npm run demo` runs it. The 10 unit tests pass, and the code compiles in strict mode. Your seed is in `.env`, which is gitignored. The holder account seeds are in `state/holders.json` and the ban list is in `state/bans.json`; both are gitignored. I haven't committed anything. Each run of the demo creates a new token and three new holder accounts, and costs about 15 XRP.