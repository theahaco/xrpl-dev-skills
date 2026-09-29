I built the issuer module and the demo script. The demo ran against testnet, every step passed, and `result.json` is written. I also queried the final state straight from a public testnet server, without my code, and it matches what you asked for:

| | Balance | Approved | Frozen |
|---|---|---|---|
| **A** `rscu2CMU9fsHR8af1ceg73ACXRgc117xEB` | 500 | yes | no |
| **B** `r2MBKFtuktBSRZ5TEvEwtBus5kTmH5ZG2` | 700 (1,000 sent, 300 clawed back) | yes | yes |
| **C** `rwK5NXubgdyFJVypiVeEBKtfeJFg5DKoR3` | 0 (110 clawed back on ban) | no (banned) | yes |

The issuance ID is `0142A1B351FE8B98F8BBB19B1726378877F08BF50E5908DB`, issued from your account. It has the allowlist, freeze, clawback and holder-to-holder transfer settings turned on, and it is not globally frozen at the end.

**Research results**
- **xrpl package:** 5.3.0 is the latest, and I read its changelog. Version 5 changed how a wallet is derived from a seed, so the code states ed25519 explicitly for your `sEd…` seed. I checked that the 5.2.0 signing change doesn't affect the transactions used here.
- **Amendments:** testnet runs rippled 3.4.1. `MPTokensV1` and `Clawback` are on. The ones for changing token settings after creation (`DynamicMPT`) and for vaults and confidential balances are off, so nothing depends on them.
- **Docs:** I read the xrpl.org pages for every transaction type and ledger object used, and checked rippled's source code for the edge cases.

**Things your compliance team should know**
1. **A freeze on the XRP Ledger doesn't stop the issuer from sending tokens.** It only blocks transfers between holders. The ledger still accepts issuer→holder payments to a frozen holder, even during a global freeze. The demo checked this with a dry run (`simulate`): it returned `tesSUCCESS`. The module refuses to issue to frozen or banned holders, or during a global freeze. That protection only covers payments sent through this module. Also, a frozen holder can still send tokens back to the issuer; the ledger allows this.
2. **A ban needs a record kept off the ledger.** On the ledger, a ban removes approval, freezes the holder and claws back the whole balance. But a banned holder can delete their empty token entry and create a new one, which looks like a fresh applicant. So banning first writes the address to a durable ban list, and the module won't approve, issue to or unfreeze anyone on it. The demo stores this list in `state/`. In production it should live in your compliance database.
3. **Some token settings are deliberately off.** I left out escrow, DEX trading and confidential balances, because each would let holders move value where a clawback can't reach it. The module also refuses to work with an existing token that has any of these on, or that uses a "permissioned domain": that lets holders of the domain's credentials hold the token without your approval.

**Decisions for you**
- **Decimals:** I set the demo token to 0 decimal places, so "500" means exactly 500 units on the ledger. A real USD stablecoin would usually use 2 or 6 decimals; the module supports any number and takes amounts as decimal strings.
- **Secrets:** your seed is in `.env` and the new holder seeds are in `.secrets/holders.json`. Both are readable only by your user and excluded from git.
- **Cost:** the run used about 15 XRP, mostly the 5 XRP sent to each holder account; your account has about 85 XRP left.

Everything is in TypeScript strict mode; see `README.md` for usage. Type-checking passes, and the 5 offline tests for amount conversion and the ban list pass. Nothing is committed to git.