The issuer module and demo are built, and the demo ran successfully on testnet. I then checked the final ledger state with raw RPC queries, independently of my own code, and it matches what you asked for exactly:

| | Balance | Approved | Frozen |
|---|---|---|---|
| A `rJLAizDYVpYEFHPsQCbxqLq3HrRhYXbBZe` | 500 | yes | no (was frozen, then unfrozen) |
| B `rpgGzzBMyaUQo9XJtirsSS31J7CTsdCwyY` | 700 (1,000 − 300 clawed back) | yes | yes |
| C `rLLuNNBZVMH7HjewiX1brZ5JhWhhb44jR2` | 0 (100 clawed back in the ban) | no | yes |

The token (`014278B17B30F9F687E10B7806694EC08BB6A72DDB768494`) is issued from your account and is not globally frozen; the demo froze it and lifted the freeze. `result.json` is written in the format you gave.

**What the research changed:**
- **`xrpl` 5.3.0 is the latest version.** Its changelog has no breaking MPT changes; I used its typed MPT transactions and XLS-89 metadata helpers.
- **Controls are permanent.** Testnet has `MPTokensV1` enabled, but not `DynamicMPT`. An issuance's capabilities can't be changed after creation, so every control is switched on when the token is created.
- **Escrow and trading are left off on purpose.** Tokens in escrow or in an AMM pool can't be taken back with a normal clawback, and allowing them would break "claw back any amount from any holder".
- **I read the ledger's own source code (rippled 3.4.0; the 3.4.1 testnet runs isn't published) to confirm the rules.** Several design choices follow from it, listed below.

**What your compliance team needs to know:**
- **Frozen holders can still send tokens back to you.** The ledger always allows this during a per-holder or global freeze. It only reduces their balance.
- **The ledger lets you send to a frozen holder.** So the module refuses to issue while the token or the holder is frozen.
- **The ledger has no concept of a ban.** A ban means revoking the holder's approval, which stops them sending or receiving at all. The module keeps a ban list and will never re-approve anyone on it. In production, that list must be stored in your database; the demo keeps it in a local file.
- **Freezing a banned holder is only a backup.** On testnet today, a frozen holder with a zero balance can delete and re-create their token entry, which removes the freeze. They are still unapproved, so they still can't receive the token.
- **Decision for you: decimal places.** The demo token uses whole units (0 decimal places), so on-ledger balances equal the amounts you listed. This setting is permanent, so choose the production value (typically 2 or 6 for a stablecoin) before issuing on mainnet.

**How it was verified:**
- **Unit tests:** 20 tests for amount handling and balance-change parsing pass. Strict typecheck and build are clean.
- **Proof on the ledger:** The demo deliberately submits payments that should fail and checks that the ledger rejects them with the expected error codes (`tecNO_AUTH` or `tecLOCKED`). This covers unapproved and banned holders, per-holder freezes and the global freeze.
- **Change after the demo run:** I fixed a bug where a payment that ran out of time was reported with `tesSUCCESS` as its failure code, and added clearer transaction labels. I didn't re-run the full demo, because that would create a second token and overwrite `result.json`. Instead I ran one extra testnet payment from banned C to A. It was rejected with `tecNO_AUTH` and changed nothing.

Your seed is only in `.env`, which is gitignored along with `.demo-state/` (holder seeds, ban list, audit trail, run log). Nothing has been committed. `README.md` covers usage and the enforcement details above.

Files are in the project directory:
- `src/issuer.ts`
- `scripts/demo.ts`
- `README.md`
- `result.json`