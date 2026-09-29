I built the issuer module and the demo script and ran the demo on testnet from your account. The ledger ends in the state you asked for; I confirmed this with direct ledger queries, separate from the module's own checks. `result.json` is written:

```json
{
  "issuanceId": "01427991DF5889C0735DDC2C2B1F2FAC1BF11E70473453E9",
  "holders": {
    "A": "racJfeig8sdtB2KQkyBagEZv16KUEqQvCh",
    "B": "rErNBfmsRY74vbJJ3eKm573udEgGcb3aGy",
    "C": "rK5yCmTTbVNa92xTdCfmYDY2gNoJZCAgie"
  }
}
```

| | Balance | Approved | Frozen |
|---|---|---|---|
| A | 500 | yes | no |
| B | 700 (sent 1,000, 300 clawed back) | yes | yes |
| C | 0 (250 clawed back when banned) | no | yes |

The token is not globally frozen, 1,200 are in circulation, and your account holds exactly one issuance. It has about 85 XRP left.

**One thing your compliance team needs to know: a freeze doesn't cover payments to or from the issuer.** Testing on testnet showed that freezes (per-holder and global) block payments between holders, but the ledger still accepts:
- **Issuer → frozen holder.** The module closes this: `issue()` refuses a frozen holder, or anyone during a global freeze. That holds as long as every issuer payment goes through the module.
- **Frozen holder → issuer.** A frozen holder can still send tokens back to you, and nothing on the ledger can stop that. Your redemption process must check whether the holder (or the whole token) is frozen before paying out fiat. I didn't make "freeze" also remove approval, because then B couldn't be both approved and frozen as you specified.

**How the controls work:**
- **Allowlist:** holders opt in, then you approve them after KYC. The ledger rejects payments to or from anyone not approved.
- **Clawback:** `clawback()` takes an exact amount and refuses if the holder has less. It works on frozen and unapproved holders.
- **Bans:** a ban is saved to a ban list first, then the holder is frozen, their approval is revoked, and their whole balance is clawed back. Running it again is safe. I checked that a banned holder can't get around it by deleting and re-creating their token entry; payments to them are still rejected. The ledger would let you re-approve a banned address, so the module checks the ban list and refuses to approve, pay or unfreeze one. In production, the ban list should live in your compliance database; the file-based version included is for a single process only.
- **Locked-in settings:** the controls can't be changed after the token is created. The module refuses to work with a token that has escrow, DEX trading or hidden (confidential) balances turned on, because tokens in those could escape clawback.

**Production notes:**
- Every call returns only after its transaction is confirmed on the ledger. If the outcome can't be determined, it raises a specific error that includes the transaction hash. Look that hash up before retrying, or the action could happen twice.
- Transactions from one process are queued so they don't collide. Run only one issuer process, or add a lock shared between processes.
- Your seed is in `.env`, which git ignores. For production, sign with a KMS/HSM or multisig instead.

**Decisions to check:**
- **Decimals:** the demo token has no decimal places, so 500 on the ledger means 500 tokens. A real stablecoin would probably use 2; the module supports that, with amounts given in the smallest unit.
- **Transfers:** holders can transfer to each other. If you want tokens to move only between you and holders, create the token with `canTransfer: false`.

Before touching your account I did two dry runs with throwaway testnet accounts, which is where I found the freeze behavior above. The holder seeds from the real run are saved in `.demo-holders.json` (git ignores it; testnet only). The full run output is in `demo-output.log` and contains no seeds. I haven't committed anything.

Files are in the project directory:
- `src/issuer.ts`
- `src/submit.ts`
- `src/banRegistry.ts`
- `src/holder.ts`
- `src/errors.ts`
- `scripts/demo.ts`
- `README.md`