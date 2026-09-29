# MPT issuer compliance module

This is the issuer side of a regulated, stablecoin-style Multi-Purpose Token (MPT) on the XRP Ledger. It is written in strict TypeScript with the `xrpl` package.

## Controls

| Control | Method(s) | On-ledger mechanism |
|---|---|---|
| Allowlist | `approveHolder`, `revokeApproval` | Issuance has `RequireAuth`. The issuer submits `MPTokenAuthorize` with `Holder`. |
| Clawback | `clawback(holder, amount)` | Issuance has `CanClawback`. Uses a `Clawback` transaction with `Holder`. |
| Ban | `ban(holder, reason)` | Records the ban, then freezes the holder, revokes approval and claws back the full balance. After that it checks the resulting state. |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | Issuance has `CanLock`. `MPTokenIssuanceSet` with `Holder` and `tfMPTLock`/`tfMPTUnlock`. |
| Global freeze | `freezeGlobal`, `unfreezeGlobal` | `MPTokenIssuanceSet` without `Holder`. |
| Issuing | `issue(holder, amount)` | `Payment` from the issuer. |

`MptIssuer.createIssuance` creates an issuance with `CanLock | RequireAuth | CanClawback | CanTransfer`. `MptIssuer.connect` attaches to an existing issuance. It refuses to proceed unless your wallet is the issuer and all of those flags are set. It also refuses `CanEscrow` and `CanTrade`: escrowed balances cannot be clawed back, and DEX trading is a transfer path this token doesn't need. On this network (no `DynamicMPT`), flags cannot be changed after creation.

### Guarantees

- A state-changing method resolves only after its transaction is in a validated ledger with `tesSUCCESS`. Any other outcome throws `TransactionFailedError` (with the engine `code`) or `TransactionExpiredError`.
- Within one `MptIssuer` instance, issuer transactions run one at a time. Concurrent calls therefore can't collide on the account sequence.
- The ledger enforces bans: the holder is unauthorized and the token requires authorization. This still holds if the holder deletes and recreates their MPToken entry. The ledger cannot stop the issuer from re-approving the address, so the `BanStore` handles that. The module refuses to `approveHolder`, `issue` to or `unfreezeHolder` a banned address.
- Amounts are integers in the token's smallest unit, passed as `bigint` or a decimal string. JS `number` is never used. `clawback` refuses to claw back more than the holder's balance.
- `ban` is idempotent. If a ban fails partway through, call it again to finish it.

### Production notes

- `FileBanStore` works for one process only. In production, implement `BanStore` on the same database as your KYC records.
- The issuer seed should come from a secrets manager or HSM-backed signer, not `.env`.
- The demo uses `assetScale: 0`, so 1 on-ledger unit equals 1 token. For a real stablecoin pick the scale before creating the issuance (e.g. 2 or 6). All amounts passed to the module are then in the smallest unit.

## Demo

```sh
npm install
cp .env.example .env   # set ISSUER_SEED
npm run typecheck
npm run demo
```

`scripts/demo.ts` does the following on testnet:

1. Funds three new holders A, B and C.
2. Creates the issuance.
3. Shows that unapproved holders can't receive the token, then approves and issues to them.
4. Globally freezes and unfreezes the token.
5. Freezes and unfreezes A.
6. Claws back 300 from B.
7. Bans C.
8. Freezes B.

Every blocked action is attempted on-ledger and asserted to fail with the expected code (`tecNO_AUTH` / `tecLOCKED`). The final state is then verified and `result.json` is written.

The demo writes the holder seeds to `data/demo-wallets.json` and the ban list to `data/bans.json`. Both files are gitignored.
