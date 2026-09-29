# MPT issuer: compliance controls

Issuer-side module for a regulated, stablecoin-style [Multi-Purpose Token](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) on the XRP Ledger.

Built with `xrpl` 5.3.0, TypeScript 7.0 (strict) and Node ≥ 22.12. It targets testnet, where `MPTokensV1` and `Clawback` are enabled and `DynamicMPT` is not.

```sh
npm install
cp .env.example .env   # fill in ISSUER_ADDRESS / ISSUER_SEED
npm test               # unit tests
npm run demo           # runs every control on testnet, writes result.json
```

## Controls

| Control | API | Ledger mechanism |
|---|---|---|
| Allowlist | `approveHolder`, `revokeApproval` | `tfMPTRequireAuth` + issuer `MPTokenAuthorize` |
| Clawback | `clawback`, `clawbackAll` | `tfMPTCanClawback` + `Clawback` |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | `MPTokenIssuanceSet` `tfMPTLock` with `Holder` |
| Global freeze | `freezeAll`, `unfreezeAll` | `MPTokenIssuanceSet` `tfMPTLock` without `Holder` |
| Ban | `ban` | ban registry → lock → unauthorize → claw back everything → verify |

Issuance and payment: `MptIssuer.createIssuance`, `MptIssuer.open`, `issue`, `getHolderStatus` and `getIssuanceStatus`.

## Behaviour compliance should know about

- **Issuance flags are permanent.** Without `DynamicMPT`, flags can't be changed after creation. `open()` refuses any issuance that lacks RequireAuth, CanLock or CanClawback. It also refuses issuances with CanEscrow, CanTrade, confidential balances or a `DomainID`, because each of those would let value or authorization bypass clawback and the allowlist.
- **A frozen holder can still send tokens back to the issuer.** This is a protocol rule (see rippled `Payment.cpp`) and applies to both the per-holder and the global freeze. Freezes block transfers between holders.
- **The ledger lets the issuer pay a frozen holder.** `issue()` refuses to do so, and also refuses to issue during a global freeze. Raw transactions signed with the issuer key outside this module are not checked.
- **Bans are enforced by the ban registry plus the ledger.** The ledger stops an unauthorized holder from receiving, but nothing on the ledger stops the issuer from re-approving them. The `BanRegistry` makes `approveHolder` refuse banned addresses. Back it with your database in production (`JsonFileBanRegistry` suits a single process).
- **One `MptIssuer` instance per issuer account.** Operations are serialized within an instance to avoid Sequence collisions.
- **Amounts are decimal strings in token units**, scaled by `AssetScale`. The demo uses `AssetScale` 0, so "500" means 500 on the ledger as well.
- **`SubmissionOutcomeUnknownError` carries the transaction hash.** Reconcile by hash before retrying.
