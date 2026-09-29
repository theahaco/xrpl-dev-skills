Done. Here's what I built and confirmed on testnet:

**Research first:**
- Latest `xrpl` npm package is `5.3.0` (published 2026-09-16). Checked GitHub releases back through `5.0.0`/`5.1.0` for MPT-related changes — notably a breaking change in `5.0.0` (`MPTAmount` value field became a plain `string`) and native Dynamic/Confidential MPT support added since, none of which affects basic MPT issuance.
- Read xrpl.org docs for `MPTokenIssuanceCreate`, `MPTokenAuthorize`, the `MPTokenIssuance` and `MPToken` ledger objects, and `Payment`'s MPT amount shape (`{ mpt_issuance_id, value }`).
- Queried the testnet server directly (`feature` RPC) and confirmed `MPTokensV1` and `fixMPTDeliveredAmount` are enabled (the amendments basic MPT operations need); `DynamicMPT`/`SingleAssetVault` are off but weren't needed.
- Cross-checked the actual shipped TypeScript types in `node_modules/xrpl` (not just docs) to get the strict-mode types right — e.g., ledger-entry types live under an `LedgerEntry` namespace export, not flat exports.

**Project** (`package.json`, `tsconfig.json` strict, `src/index.ts`): connects to `wss://s.altnet.rippletest.net:51233`, uses your issuer account, funds a fresh holder via the testnet faucet, then:
1. `MPTokenIssuanceCreate` with `tfMPTRequireAuth` set (only approved holders can hold it).
2. Holder self-opts-in via `MPTokenAuthorize`, then issuer approves via `MPTokenAuthorize` with `Holder` set.
3. `Payment` of 1000 MPT to the holder.
4. Reads back `MPToken.MPTAmount` and `MPTokenIssuance.OutstandingAmount` via `ledger_entry`.

**Verified independently** via raw JSON-RPC against testnet (not just the script's own output): the issuance has `Flags: 4` (`lsfMPTRequireAuth`), and the holder's `MPToken` has `Flags: 2` (`lsfMPTAuthorized`) with balance 1000, matching outstanding 1000.

`result.json`:
```json
{
  "issuanceId": "01427FFB3965C312E6EA31B329DEF07E6BEC493C05742B2F",
  "holder": "rGFsHtPdAfwQUDYDVTxm3nFN82hDWEuVPC",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Nothing has been committed to git — let me know if you'd like that done.