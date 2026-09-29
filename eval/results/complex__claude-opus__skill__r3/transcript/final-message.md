The issuer module and demo are built, and the demo ran against testnet with your account. The ledger now matches the end state you described. I checked it with direct ledger queries, separately from the demo's own checks.

`result.json`:
```json
{
  "issuanceId": "0142A143126F8FA954B6A86F4CCE29013178066AD89D92AA",
  "holders": {
    "A": "rhJc9ih4zs2a1qM4kwvkqVCGoLwyUxwARy",
    "B": "rJfHyffg2hTPFs7cZwi3XUh5LPNNC7VHVH",
    "C": "rK8EMCpELFqf4RUXZskkhpTK4UrkUbd1Kh"
  }
}
```

| | Balance | Approved | Frozen |
|---|---|---|---|
| A | 500 | yes | no |
| B | 700 (sent 1,000, 300 clawed back) | yes | yes |
| C | 0 (sent 250, all clawed back when banned) | no, and recorded as banned | no |
| Token | 1,200 in circulation | | not globally frozen |

- **Your account:** it owns exactly one token issuance, with all the controls switched on. Escrow, trading and confidential balances are deliberately off, because tokens held in those places aren't covered by the controls in the same way. These settings can't be changed after the token is created on testnet.
- **Testing on the ledger:** besides the happy paths, the demo tried the actions the controls should stop and confirmed the ledger rejected them. That covers transfers to an unapproved holder, transfers to or from a frozen holder, transfers during the global freeze, and payments to C after the ban. It also covers C deleting its token entry and opting in again to try to reset the ban.
- **Offline tests:** 22 unit tests pass, and the strict typecheck and build are clean.
- **Rehearsal first:** I ran the whole demo once with a throwaway testnet account before touching yours. Your account spent about 15 XRP funding A, B and C (5 each) plus fees, and has about 85 XRP left.

**Something your compliance team needs to know:** a freeze doesn't fully match "can't send or receive" on the ledger. On testnet, a frozen holder (or everyone, during a global freeze) could still receive tokens from your account and send tokens back to it. The freeze only blocks transfers between holders. The module closes the first gap by refusing to send tokens to a frozen holder or during a global freeze. Holders sending tokens back to you during a freeze can't be blocked on the ledger. Bans don't have this gap: once a holder's approval is revoked, they can't send or receive at all, even with your account.

**Choices you may want to change:**
- **Whole tokens:** I created the token with no decimal places, so "holds 500" is exactly 500 on the ledger. A real stablecoin would likely use 2 decimal places, and that has to be decided before creating the mainnet token. The module works in the smallest unit and includes helpers to convert to and from decimal amounts.
- **Supply cap:** I capped total supply at 1,000,000,000.
- **Clawing back more than a holder has:** the ledger would silently take the whole balance. The module refuses instead, so the audit trail always shows the exact amount.

**How the module is put together:**
- **Every call either finishes or fails clearly.** It returns only after the transaction is confirmed on the ledger. Otherwise it raises an error that says whether the transaction definitely didn't happen, failed on the ledger, or has an unknown outcome and must be checked before retrying.
- **Checks run just before signing.** Whether someone is banned or frozen is checked right before each transaction is signed, and transactions go out one at a time. That stops a ban or freeze being jumped by a transaction queued after it. This only holds within one process, so in production all issuer transactions should go through a single service.
- **The ban list lives off-ledger.** The ledger has no "banned" marker, so a separate ban list stops anyone approving that address again. The demo keeps it in a local file (`data/bans.json`). In production it should live in your compliance system of record.
- **Every action is audit-logged,** including refused and failed attempts (`data/audit.jsonl`).

**Secrets:** your seed is in `.env` and the holder seeds are in `.secrets/holders-*.json`, both readable only by you and excluded from git. Nothing is committed yet. Each demo run creates a new token and new holders, so re-running it would add a second token to your account and change which token `result.json` points to.

Files are in `src/` (`issuer.ts` is the API your backend calls, `demo.ts` is the demo) and `test/`. The `README.md` covers the controls, the ledger behaviour the design depends on, and a checklist for going to production (key custody, ban list storage, audit storage, mainnet settings).