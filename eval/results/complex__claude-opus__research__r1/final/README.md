# mpt-regulated-issuer

Issuer-side compliance controls for a regulated, stablecoin-style token issued as an XRPL
[Multi-Purpose Token](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens).
Built on `xrpl@5.3.0` and verified on testnet (rippled 3.4.1, `MPTokensV1` enabled).

## Controls

| Control | Method | Ledger mechanism |
|---|---|---|
| Allowlist | `authorizeHolder`, `revokeAuthorization` | `lsfMPTRequireAuth` + issuer `MPTokenAuthorize` |
| Clawback | `clawback(address, amount \| 'all')` | `Clawback` (`lsfMPTCanClawback`) |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | `MPTokenIssuanceSet` + `Holder` + `tfMPTLock`/`tfMPTUnlock` |
| Global freeze | `freezeAll`, `unfreezeAll` | `MPTokenIssuanceSet` + `tfMPTLock`/`tfMPTUnlock` |
| Ban | `banHolder(address, reason)` | ban registry → lock → revoke auth → claw back all → verify |
| Issuance | `issue(address, amount)` | `Payment` from issuer, after compliance pre-checks |

Amounts are decimal strings in whole-token units (`"12.50"`), converted exactly using the issuance's `AssetScale`.
Every call waits for validation and throws `ComplianceError` (refused before submission; nothing sent),
`InvalidInputError`, or `TransactionFailedError` (carries `engineResult` and `hash`; reconcile before retrying).
State-changing calls are idempotent: if the ledger is already in the target state they return `{ changed: false }`.

```ts
const issuer = await MptIssuer.attach(
  { client, wallet, banRegistry, expectedNetworkId: 1 /* testnet */ },
  issuanceId,
)
await issuer.authorizeHolder(address) // after KYC; the holder must have opted in first
await issuer.issue(address, '100.00')
await issuer.banHolder(address, 'case #1234')
```

## Behaviour your compliance team should know

- **A frozen holder can still redeem to the issuer.** The protocol always permits a locked balance to be sent
  back to the issuer. It cannot move to anyone else, and nobody else can send to it.
- **The ledger does not stop the issuer from paying a frozen holder**, or paying anyone during a global freeze
  (verified on testnet). `issue()` refuses these cases; do not send issuer payments outside this module.
- **Bans rely on the ban registry.** A banned holder whose balance is zero can delete their `MPToken` entry and
  re-create it, which clears the lock. The new entry is unauthorized, so it still cannot receive tokens, but the
  ledger has no record that the address was banned. `authorizeHolder` and `issue` check the `BanRegistry`.
  In production, implement `BanRegistry` on your database; `FileBanRegistry` is for single-process tooling.
- **Run one `MptIssuer` per issuer account** (calls are serialized per instance), or add a distributed lock.
- New issuances disallow escrow and confidential balances, because a plain `Clawback` can't reach funds in them.
  `attach` refuses an issuance that allows either.
- Not available on testnet today, so not used: `DynamicMPT` (the capability flags can't be changed after creation),
  and `DomainID`-based allowlisting (it requires `SingleAssetVault`).

## Scripts

```sh
npm test          # unit tests (amount maths, ban registry)
npm run typecheck
npm run build     # emits dist/
npm run demo      # end-to-end testnet demo; needs .env (see .env.example); writes result.json
```

The demo creates a **new** issuance and three new funded holder accounts every time it runs (about 15 XRP).
Holder seeds are written to `state/holders.json` and the ban registry to `state/bans.json` (both gitignored).
