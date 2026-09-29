Everything is in place and untracked (I haven't committed anything, per the no-unsolicited-commit rule). Summary:

**Research done first:**
- Latest `xrpl` npm package: **5.3.0** — installed and verified its actual `.d.ts` files for `MPTokenIssuanceCreate`, `MPTokenAuthorize`, `Payment`, and the `MPToken`/`MPTokenIssuance` ledger-entry types, rather than trusting docs alone.
- Read xrpl.org references for `MPTokenIssuanceCreate`, `MPTokenAuthorize`, `Payment` (MPT amounts), and the `MPToken`/`MPTokenIssuance` ledger objects.
- Queried testnet directly (`feature` RPC) and confirmed **MPTokensV1** and **fixMPTDeliveredAmount** are enabled (DynamicMPT is not, so I avoided `ImmutableFlags`).

**What the script (`src/index.ts`) does, all executed live on testnet:**
1. Funds a freshly generated holder account from your issuer account.
2. Issues an MPT via `MPTokenIssuanceCreate` with `tfMPTRequireAuth` set, so only issuer-approved accounts can hold it.
3. Holder opts in via `MPTokenAuthorize`, then issuer approves that holder via `MPTokenAuthorize` with `Holder` set.
4. Sends 1,000 units via `Payment` with an MPT `Amount` (`{ mpt_issuance_id, value }`).
5. Reads the balance back via `ledger_entry` (`mptoken` and `mpt_issuance` params) and writes `result.json`.

**Result, confirmed on ledger:**
```json
{
  "issuanceId": "01427FBD7A3B2BEAB0FB00C2C48210FD79E31D3AB3D86F0B",
  "holder": "rNeKiDjUUdW2qyMvmTFHyBfSJJPyruu9us",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

`npx tsc --noEmit` passes clean under `strict: true`. Nothing has been committed to git — let me know if you'd like me to commit this.