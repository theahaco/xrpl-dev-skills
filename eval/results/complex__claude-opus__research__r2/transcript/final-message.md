I've built the issuer module and demo, run the demo against testnet from your account, and written `result.json`. The final ledger state matches your spec exactly. I checked it against the raw ledger, separately from my own code.

```json
{
  "issuanceId": "0142A0F5AFEB8D53282D05913DF7D20348AE5C184CC3AA44",
  "holders": {
    "A": "rEcJPJRdiDiiiLBGu2W5tpAtWqpkZUgcba",
    "B": "rGs17W1ovU1HAKnyusrrWFGjbTKxmzKTMq",
    "C": "rBB3HYL7CmraiPpsXqkxJXcK3TkrwwZVhE"
  }
}
```

| | Balance | Approved | Frozen |
|---|---|---|---|
| A | 500 | yes | no (frozen, then unfrozen) |
| B | 700 (sent 1,000, 300 clawed back) | yes | yes |
| C | 0 (sent 250, then banned) | no | yes |

The token was globally frozen and unfrozen during the demo, so it isn't frozen now. Your account owns exactly this one issuance: I rehearsed the whole demo three times with throwaway accounts from the testnet faucet before touching yours.

**Research results**
- **`xrpl`:** I used 5.3.0, the latest. From its changelog: since 5.0, a seed's key type is inferred from its prefix, so I set it explicitly; there's a built-in XLS-89 metadata encoder, which I used. The other tools are the latest too: TypeScript 7.0.2, tsx 4.23.15, @types/node 26.6.3.
- **Testnet amendments:** testnet runs rippled 3.4.1, and `MPTokensV1`, `Clawback` and `TokenEscrow` are enabled. `DynamicMPT` is not enabled, so the token's settings can't be changed after creation. `ConfidentialTransfer` and `fixCleanup3_4_0` aren't enabled either; the second one matters for bans (below).

**How it's built:** the module is in `src/`, with `issuer.ts` at its core, and the demo is `src/demo.ts`. The token always has approval required, freezing and clawback switched on. Escrow, trading and confidential balances are always off, because they would let tokens get out of clawback's reach. Every action waits for a validated ledger and fails loudly on anything other than success. There are 12 unit tests, all passing.

**Things your compliance team should know** (all tested on testnet):
1. **A freeze doesn't stop your own account.** The ledger blocks all payments between holders, but still lets the issuer pay a frozen holder, even during a global freeze. The module refuses to do it, so all issuing must go through the module.
2. **Frozen holders can still send tokens back to the issuer.** The protocol always allows this, so "can't send" means can't send to anyone except you.
3. **The on-ledger freeze alone doesn't make a ban stick.** Because `fixCleanup3_4_0` isn't enabled, I showed that a banned holder with a zero balance can delete their frozen token record and create a fresh one. What makes the ban hold is that their approval is revoked and the module refuses to approve them again. Payments to them failed with `tecNO_AUTH` both before and after they recreated the record. That means the ban list needs to live in your system of record; the file-based version I wrote is only suitable for the demo.
4. **Amounts are whole units.** I set the token to 0 decimal places, so 500 on the ledger is exactly 500 tokens. A real stablecoin would usually use 2 or 6, and the module supports that.
5. **Memos are public.** Each action can attach a reference to the ledger, and anyone can read it, so use case IDs only, never personal data. The written reason for a ban stays off the ledger.

**Where things are:** your seed was only passed in as an environment variable and isn't stored anywhere. The holders' seeds and the ban list are in `.state/`, which is excluded from git and readable only by your user. Nothing is committed yet. The `README.md` covers usage and the full list of caveats.