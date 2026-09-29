I've built the issuer module and demo, and run the demo on testnet with your account as the issuer. The ledger ends in exactly the state you described, confirmed both through the module and by reading the ledger entries directly. `result.json` is written.

## Final testnet state
Issuance `01427A31F68CC0D283A4122A8E349A755B7779DE0834B6CC`, issued from `rP7dqtuV1DGUov5AwHvem5NxADjwM6nznP`. It has allowlisting, freezing, clawback and holder-to-holder transfers enabled, and is not globally frozen.

| Holder | Address | Balance | Approved | Frozen |
|---|---|---|---|---|
| A | `rDZAfBsVf7QquVqt6FJb9Wfm7pNWR4e7sQ` | 500 | yes | no |
| B | `rMrQvL7whx1XamDviFYTeMTtydJ3xaoF2` | 700 | yes | yes |
| C | `rqVwsohvyC6qqYqUR48aDMvqFNvj2vz4E` | 0 | no (banned) | yes |

The demo didn't just perform the actions. It also tried the transfers that should be blocked and confirmed they fail on the ledger: frozen holders can't send or receive, nobody can send during the global freeze, and nobody can send to the banned holder. It cost your account about 15 XRP, almost all of it the 5 XRP sent to each new holder account.

## Research findings that shaped the design
- **xrpl 5.3.0** is the latest version. Other packages are also on their latest versions (TypeScript 7.0.2, tsx, dotenv 18).
- **Testnet amendments:** the features this needs (`MPTokensV1`, `Clawback`) are enabled. `DynamicMPT` is not, so all the controls have to be switched on when the token is created and can't be added later. The module does that and refuses to manage a token that's missing them.
- The module also refuses tokens that allow escrow or exchange trading. Those features would let a holder move tokens somewhere a clawback can't reach.

## Two protocol behaviors your compliance team needs to know
I tested these on testnet before writing the module. The docs don't make them clear:
1. **The ledger lets the issuer send tokens to a frozen holder,** even during a global freeze. The module refuses these payments itself, so "frozen holders can't receive" only holds if all issuance goes through the module.
2. **A frozen holder can still send tokens back to the issuer.** This is the ledger's built-in redemption path and can't be turned off. Transfers between holders are fully blocked.

For the same reason, a ban is more than "remove approval": removing approval leaves the balance stuck where it is. A ban does four things, in order:
- saves the ban to a persistent ban list
- removes the address's approval, which blocks all sending, even back to the issuer
- freezes the address
- claws back its entire balance in one transaction

The ban list stops the module ever re-approving that address. It's a JSON file for now and should move to your database before production.

## Things to note
- **No decimal places:** I created the token with 0 decimal places so ledger amounts read literally (500 = 500). The module supports decimals, but this can't be changed on an existing token. If you want cents, it has to be a new issuance.
- **Secrets:** your seed is in `.env` and the holder seeds are in `.secrets/demo-holders.json`. Both are excluded from git.
- **Nothing committed:** I haven't committed anything to git.

The README covers usage, how each control maps to ledger transactions, and these caveats. `npm run verify` re-checks the ledger state at any time. The core logic is in `src/issuer.ts`, and there are 15 unit tests (all passing).