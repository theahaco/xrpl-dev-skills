I've built the issuer module and the demo, and run the demo against testnet. The ledger now matches your spec: I checked it by reading the raw ledger entries directly, not just through the module.

**One thing your compliance team needs to know:** freezes don't stop your own issuer account from sending tokens. On testnet, the ledger rejects any transfer to or from a frozen holder, and every holder-to-holder transfer during a global freeze. But it still accepted a payment from the issuer to a frozen holder, and during a global freeze. The module refuses to issue in both cases, so "a frozen holder can't receive" only holds if every issuance goes through the module. Anyone with the issuer seed could bypass it, so access to that key matters. Bans don't have this gap: once a holder is banned, the ledger rejects even the issuer's payments to them.

**`result.json`**
```json
{
  "issuanceId": "014279B9794DFE173BFA3730D024E6D073FB4177E1490A3C",
  "holders": {
    "A": "rP3DRGhEsakeVr5oDpigNM7PhHZagVCr3V",
    "B": "r4hTRs1AXFya9UdKjTLAK84rUC7pgCd3AH",
    "C": "r3jXD3UXfRxGggYifTmStzcRznYDfXysJ9"
  }
}
```

**Final ledger state**
- **Token:** issued from your account with all five controls available, not globally frozen. 1,200 tokens are in circulation, and it's the only issuance on your account.
- **A:** approved, holds 500, not frozen.
- **B:** approved, holds 700, frozen.
- **C:** holds 0, removed from the allowlist, frozen.

**How each control is enforced**

| Control | Enforced by |
|---|---|
| Allowlist | The ledger: unapproved holders can't receive the token, even from the issuer. |
| Clawback | The ledger; it still works on frozen and banned holders. |
| Per-holder and global freeze | The ledger for holder-to-holder transfers; the module for the issuer's own payments (the gap above). |
| Ban | Four steps: record the ban → freeze the holder → claw back their whole balance → remove them from the allowlist. The module then re-reads the ledger to confirm all of it. |

**Things to know before production**
- **Bans need a durable record.** On the ledger, a banned holder is left frozen, removed from the allowlist and at zero balance. However, the holder can delete that empty entry, and then only the ban record stops someone re-approving them. The demo keeps that record in a local file; in production it should live in your compliance database.
- **Run one copy of the module per issuer key.** It processes one action at a time within a single process; two processes using the same key could interfere with each other.
- **Transactions are signed locally.** An action only counts as done once the ledger has confirmed it. If the outcome is uncertain, the error includes the transaction hash to look up before retrying.
- **No decimal places in the demo token.** "500 tokens" is exactly `500` on the ledger. The module handles any number of decimal places.
- **Capabilities are fixed at creation.** Testnet doesn't yet support changing them later. The module always turns on the allowlist, freeze and clawback, and turns off escrow, because escrowed tokens would be out of reach of clawback.

**How I ran it**
- The TypeScript compiles under strict mode, and the unit tests for amount handling pass.
- I first ran the full demo against a throwaway issuer funded from your account, to confirm how the ledger behaves without adding anything to your account. That run is how I found the freeze gap.
- Your account now has about 67 test XRP, after funding the holders and the rehearsal accounts.

The holders' seeds and your seed are in `demo-wallets.json` and `.env`, which are gitignored and hold testnet keys only. Nothing has been committed. `README.md` covers usage and these caveats.

Files are in the project directory:
- `src/issuer.ts`
- `src/submit.ts`
- `src/banStore.ts`
- `scripts/demo.ts`
- `README.md`
- `result.json`