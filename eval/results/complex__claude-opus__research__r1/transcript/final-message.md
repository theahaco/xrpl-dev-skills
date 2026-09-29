The issuer module and demo are built, and the demo ran cleanly against testnet. I checked the final state directly over JSON-RPC, without going through my code, and it matches what you asked for:

| | Balance | Approved | Frozen |
|---|---|---|---|
| A `rB2FncG54tn3Fu2jeVgR2L1k7gnJgWCmmf` | 500 | yes | no |
| B `rNcLNSsdDi4n53PD2urPgedxBGB7A6CZK5` | 700 | yes | yes |
| C `rPqZQCp2YnVuK2uKMbfjzts9k4AW8T5Heg` | 0 | no | yes (banned) |

The issuance is `01429FEA0D23B5ECA3F7F73046F58071BD0DD73768AE8621`. It is issued from your account, has Require Auth, Can Lock, Can Clawback and Can Transfer enabled, and is not globally frozen at the end. `result.json` is written, and `demo-report.json` lists every step with its transaction hash. The 12 unit tests pass and strict type-checking is clean.

**Research that shaped the design**
- `xrpl` 5.3.0 is the latest. Since v5 it picks the key type from the seed, so I load your seed as ed25519 explicitly.
- Testnet runs rippled 3.4.x. MPTs and Clawback are enabled there. DynamicMPT and `fixCleanup3_4_0` (the amendment that stops holders deleting a locked token record) are not. So issuance settings are fixed when the token is created.
- If DynamicMPT is enabled when an issuance is created, the module detects it and permanently locks the issuance settings. That path has only been unit-tested, because the amendment isn't live on testnet.

**Controls**
- **Allowlist:** only holders you approve can receive the token. The demo showed a payment to an unapproved holder being rejected by the ledger.
- **Clawback:** takes back an exact amount or `'all'`, whether or not the holder is frozen or approved. Asking for more than the balance is an error rather than silently taking less.
- **Per-holder and global freeze:** both block transfers between holders; the demo showed the ledger rejecting them. The module also refuses to issue tokens to a frozen holder, or to anyone during a global freeze.
- **Ban:** records the address in a ban list saved to disk first, then removes approval, freezes the holder and claws back everything. The module then refuses to re-approve, pay or unfreeze that address.
- **Blocked token settings:** the token is created without escrow, DEX trading, confidential balances or credential-based access. Each would let tokens move out of reach of clawback, freezes or the allowlist, and the module refuses to manage an issuance that has any of them.
- **Transaction handling:** issuer transactions go through one at a time. An action only counts as done once it is confirmed in a validated ledger.

**Where the ledger doesn't fully match your spec — please review with compliance**
1. **A frozen holder can still send tokens back to the issuer.** The ledger allows this on purpose (it's how redemption works), and I confirmed it on testnet with a dry run. It burns the tokens rather than moving them to anyone else. If that isn't acceptable, also call `revokeApproval()`: unapproved holders can't send to anyone.
2. **The ledger has no "banned" state.** A banned address just looks unapproved and frozen. Until `fixCleanup3_4_0` is enabled, a banned holder can delete their empty token record and open a fresh, unapproved one. They still can't receive the token, but the ban list is the only thing stopping someone re-approving them. In production it should be backed by your database, not the JSON file.

**Choices you may want to change**
- **Decimals:** the demo token uses zero decimal places, so "500" on the ledger means 500 tokens. A USD stablecoin would normally use 2 decimal places; the module supports that, but then amounts are in cents.
- **Test runner:** the newest vitest (5.0.2) can't be installed right now, because one of its dependencies is missing from npm. I used Node's built-in test runner instead.
- **Node types:** I pinned `@types/node` to 24.x to match your Node 24, rather than the newest 26.x.
- **Funding:** each holder was funded with 5 XRP from your account.

Your seed is in `.env`, which is gitignored. Nothing has been committed.

Files are in the project directory:
- `src/issuer.ts`
- `src/submitter.ts`
- `src/banRegistry.ts`
- `scripts/demo.ts`
- `test/unit.test.ts`
- `README.md`
- `result.json`
- `demo-report.json`