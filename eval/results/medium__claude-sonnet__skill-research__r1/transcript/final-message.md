Everything is in place; I haven't committed anything since you didn't ask for that.

## Summary

Research done first:
- **xrpl npm package**: latest is `5.3.0` (installed exactly that).
- **xrpl.org docs**: read `MPTokenIssuanceCreate`, `MPTokenAuthorize`, `Payment`, and the `MPTokenIssuance`/`MPToken` ledger objects; also cross-checked the shipped TypeScript sources in `node_modules/xrpl/src` since they're authoritative for the exact field/flag names in this version.
- **Testnet amendments**: queried `s.altnet.rippletest.net` directly — `MPTokensV1` and `fixMPTDeliveredAmount` are enabled; `DynamicMPT` is not (so no `ImmutableFlags` usage).

What the script (`src/index.ts`) does:
1. Loads your issuer account from the seed, generates a fresh holder keypair, and funds it with a `Payment` from the issuer (5 XRP — covers base + owner reserve).
2. Issues an MPT via `MPTokenIssuanceCreate` with `tfMPTRequireAuth` set, so only approved holders can hold it.
3. Holder opts in via `MPTokenAuthorize`, then the issuer approves that holder via `MPTokenAuthorize` with `Holder` set (allow-listing — order matters, confirmed from docs).
4. Sends 1,000 tokens via `Payment` with an `{ mpt_issuance_id, value }` amount.
5. Reads back `MPTAmount` from the holder's `MPToken` object and `OutstandingAmount` from the issuer's `MPTokenIssuance` object, and writes `result.json`.

One bug found and fixed along the way: the `MPTokenIssuance` ledger object has both an `index` (the ledger-entry hash) and a separate `mpt_issuance_id` field — I initially matched on the wrong one and fixed it after inspecting the actual RPC response.

Everything ran against testnet for real — I independently re-queried the ledger via a fresh `curl` afterward and confirmed `result.json` matches on-chain state exactly:

```json
{
  "issuanceId": "01427F9438627FA93354EBE7A12AE16AE7C714F235B7DBDA",
  "holder": "rpgTeyv7UP6zNAKojorT4nwhdxJ5QY12j3",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```