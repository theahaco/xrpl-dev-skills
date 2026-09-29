The issuer module and demo are built, the demo ran against testnet with your account as issuer, and `result.json` is written. I checked the final state over raw RPC, bypassing my code, and it matches what you asked for:

| | Balance | Approved | Frozen |
|---|---|---|---|
| A `rKrayLUJjNBZzMLb5DfsmVVKm4GArZCyPE` | 500 | yes | no (was frozen, then unfrozen) |
| B `rHjNJA3uCudqdH9JLi8CGfZjyabuqxrZx` | 700 (1,000 issued, 300 clawed back) | yes | yes |
| C `rB268ty3x8fNeMZKSqbKPoKjvMrZb7zM8` | 0 (250 clawed back when banned) | no | yes |

The token's issuance ID is `01429FEA0D276DCF57A08AC4B2BF3304DAC3B93A29EF9B66`. It was frozen globally and then released, so it isn't frozen now. The demo also tested each control: blocked transfers came back rejected by the ledger, and allowed ones went through. Your account spent about 15 XRP, mostly funding the three holders.

**What the research changed:**
- **xrpl 5.3.0:** since version 5, the library works out the key type from the seed, so the code states it explicitly and checks that your seed produces your address.
- **Testnet:** the token features, clawback and token escrow are enabled. The feature that would let token settings change after creation (`DynamicMPT`) is not, so the settings were fixed when the token was created.
- **Settings left off:** escrow, trading, private (encrypted) balances and credential-based approval are all switched off. Escrowed tokens can't be clawed back, and credential-based approval would bypass the allowlist and bans. The module refuses to manage a token that has any of these on.

**Two things the ledger doesn't enforce, which your team should know:**
- **Paying frozen holders:** holders can't pay each other while one side is frozen or the token is globally frozen. But the ledger still lets *your* account pay a frozen holder in both cases. The module's `issue()` blocks this itself, and the demo shows both the ledger's behaviour and the module's refusal.
- **Bans:** the ledger can't make a ban permanent. Once a banned holder is at zero, they can delete their token holding on testnet, which removes the freeze. They still can't receive anything unless they're approved again. To stop that, the module checks a ban list before every approval and issue. The demo stores that list in a JSON file; in production it should live in your compliance database.

**Other points:**
- **One instance per account:** the module sends your account's transactions one at a time so they can't conflict. Run a single instance per issuing account, because two backend processes using the same account could still collide.
- **Decimals:** the demo token uses no decimal places, so "500" means exactly 500. The module supports decimals and has conversion helpers, which have unit tests. The module itself has no automated tests; the testnet demo is its only end-to-end check.
- **Rehearsal token:** before using your account, I ran the whole demo once with throwaway accounts from the testnet faucet. That created a separate test token under a throwaway issuer, which you can ignore.
- **Secrets:** your seed is in `.env` and the holders' seeds are in `secrets/`. Both are gitignored, and nothing is committed.

Files are in the project folder:
- src/issuer.ts
- src/banRegistry.ts
- src/amounts.ts
- src/errors.ts
- scripts/demo.ts
- test/amounts.test.ts
- README.md
- result.json