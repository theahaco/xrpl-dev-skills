The issuer module and demo are built, and the demo ran successfully against testnet using your account as the issuer. I checked the final state separately with raw RPC calls, outside my code, and it matches what you asked for:

| | Ledger state |
|---|---|
| Token `014279FEB0B46FD0AFEBDE2E9C069EA738DAF23647BAACCF` | Issued by `rHfLnjJJ…`; the allowlist, freeze and clawback flags are all on; not globally frozen; 1,200 in circulation |
| A `rByL3WmCXi3LcuBMUDuTz614H2MnN98AZM` | Approved, 500, not frozen |
| B `rnpHK8kfB2BokY8Sk7gcKcYBvgqhawZZQg` | Approved, 700, frozen |
| C `rshvm77ECFzK28f3QBvsjraJxfkqPTkpcP` | Balance 0, approval revoked, frozen, banned |

`result.json` is written in the format you gave. The 10 unit tests pass (amount conversion and reading clawback results).

**Research findings that shaped the design:**
- **`xrpl` 5.3.0 is the latest.** Since v5 it works out the key type from the seed, so the code states ed25519 for your `sEd…` seed explicitly. It also uses TypeScript 7.0.2 and the latest `@types/node`.
- **Controls must be chosen when the token is created.** The testnet amendment that allows changing token settings later (DynamicMPT) isn't enabled, so the module switches every control on at creation. It also refuses to manage any existing token that is missing one.
- **Holders can't escrow the token.** Clawback can't reach escrowed funds, so an escrow could be used to dodge a ban. Escrow is deliberately left off.

**Found during testing: the ledger lets the issuer send tokens to a frozen holder.** A per-holder freeze only blocks transfers between holders. The module refuses to issue to a frozen holder, or to anyone during a global freeze, so all minting should go through it. This is also why a ban doesn't rely on freezing alone. A ban freezes C, claws back the whole balance and revokes C's approval. The revoked approval is what makes the ledger reject any further payment to C, which I confirmed on testnet.

**Before production:**
- **Bans need a permanent record.** On the ledger a banned address looks the same as one that hasn't been approved yet, so the module keeps its own ban list and checks it before approving or paying anyone. The demo keeps that list in memory; your backend should store it in its database, such as the KYC store.
- **Only one process should sign for the issuer account.** Operations are queued one at a time within a process, but two processes signing at once will clash.
- **Decimals.** The demo token has no decimal places, so "500" on the ledger means exactly 500 tokens. A real stablecoin would probably use 2 or 6. The module handles that conversion, but the setting can't be changed after creation.

To keep your account clean, I first rehearsed the whole demo with throwaway faucet-funded issuers. Your account holds only the one token; the real run cost about 15 XRP (5 XRP to fund each holder, plus fees and reserve), leaving about 85 XRP.

Your seed is in `.env` and the three holders' testnet seeds are in `demo-holders.secret.json`; git ignores both. Nothing is committed yet. `npm run demo` creates a new token each time it runs. `README.md` covers usage and these design notes.