I built the issuer module and the demo script, and ran the demo on testnet with your account as issuer. It finished in exactly the state you described, and `result.json` is written. I checked the final state by reading the raw ledger objects directly, not through my own code:

| | Balance | Approved | Frozen |
|---|---|---|---|
| A `r3rWvoamWg3vQYpcphTWT4xGnUbtz8Q9wx` | 500 | yes | no |
| B `r4YHCUEWMb4RNBjGxP5KU3qCWVuFLbomyF` | 700 | yes | yes |
| C `rPrLeipvy9yh3uyJEcmMFcoWas73piEr2R` | 0 | no (banned) | no |

- **Token:** issuance ID `014277075EE61297F2E13500B9A887302AFB0A1204C7C5A8`. It's the only issuance on your account, it isn't globally frozen, and total supply is 1,200.
- **Every control was exercised:**
  - Sending to A before approval was rejected by the ledger.
  - Transfers to and from A were rejected while A was frozen and worked again after unfreezing.
  - All holder-to-holder transfers were rejected during the global freeze.
  - 300 was clawed back from B.
  - C was banned and all 250 of C's tokens were clawed back. After that, sending to C was refused by the module and also by the ledger when I bypassed the module.
- **Tests:** the demo checks the final state itself and only writes `result.json` if everything matches. The 6 unit tests and the strict typecheck pass.

**Something your compliance team needs to know:** on the XRP Ledger, freezing a holder only blocks transfers between holders. I tested this on testnet:
- **You can still pay a frozen holder.** The ledger allows it, both for single-holder and global freezes. The module refuses these payments itself, so a freeze covers new issuance as long as payments go through the module.
- **A frozen holder can still send tokens back to you.** This is how the XRP Ledger's freeze is designed. The only way to block it is to revoke the holder's approval, which would have contradicted "B is approved and frozen". The tokens only come back to you, but your backend must not pay out fiat for tokens returned by a frozen holder. `getHolderState()` tells you whether a holder is frozen.

**Other decisions:**
- **Bans are stored off the ledger.** On the ledger, a banned holder looks the same as one who hasn't been approved yet, so the ban list (`BanStore`) is the source of truth. The demo uses a JSON file; in production it should live in your database and be checked by anything that approves holders. A ban revokes approval first, then claws back the full balance, then re-checks the ledger. If a ban fails partway, calling it again picks up where it left off.
- **Features that could let funds escape clawback are turned off.** Escrow, DEX trading and confidential balances can't be enabled on this token. The module checks this, and that it's the issuer, whenever it connects to the token, and refuses to work otherwise.
- **Amounts have no decimal places,** so "500" on the ledger means 500 tokens. A real stablecoin would usually use 2 or 6; that's one setting.
- **Every action is written to an audit log** with its transaction hashes.
- **Run one issuer process at a time.** The module queues the issuer's transactions so they don't collide, but only within a single process.

**Housekeeping:**
- I first did a full practice run on a throwaway testnet account from the public faucet, so the problems I found never touched your account. That run is where I found the freeze behaviour.
- The real run cost about 9 XRP of your balance (3 XRP to fund each holder, plus fees).
- Your seed is in `.env` and the holder seeds are in `data/holders.json`; both are excluded from git.
- Nothing has been committed.

The module is in `src/issuer.ts`, the demo is `scripts/demo.ts`, and the README covers usage and these caveats.