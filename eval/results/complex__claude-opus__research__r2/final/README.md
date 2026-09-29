# MPT issuer: compliance controls

Issuer-side module for a regulated, stablecoin-style [Multi-Purpose Token](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) on the XRP Ledger. Built on `xrpl` 5.3.0. Targets testnet (rippled 3.4.1, `MPTokensV1` + `Clawback` enabled).

```ts
import { Client, Wallet } from 'xrpl'
import { FileBanRegistry, MptIssuer } from 'mpt-issuer'

const issuer = await MptIssuer.attach(
  { client, wallet: Wallet.fromSeed(seed), banRegistry: new FileBanRegistry('bans.json'), onAudit: writeAuditLog },
  issuanceId,
)
await issuer.authorizeHolder(address, { reference: 'KYC-1234' }) // allowlist (holder must opt in first)
await issuer.issue(address, '500')
await issuer.clawback(address, '300')      // more than the balance claws back everything
await issuer.freezeHolder(address)         // / unfreezeHolder
await issuer.freezeAll()                   // / unfreezeAll
await issuer.ban(address, { reason: 'internal only', reference: 'CASE-99' })
await issuer.getHolder(address)            // { authorized, frozen, banned, balance, ... }
```

Every method waits for a **validated** ledger and throws unless the result is `tesSUCCESS`. Amounts are decimal strings in display units, converted using the issuance's `AssetScale`.

## How each control is enforced

| Control | Ledger mechanism | Notes |
|---|---|---|
| Allowlist | `tfMPTRequireAuth` + issuer `MPTokenAuthorize` | The holder must opt in first; the issuer then approves. |
| Clawback | `tfMPTCanClawback` + `Clawback` | Works on frozen and unauthorized holders. |
| Per-holder freeze | `tfMPTCanLock` + `MPTokenIssuanceSet` with `Holder` | The ledger blocks all holder↔holder payments (`tecLOCKED`). |
| Global freeze | `MPTokenIssuanceSet` without `Holder` | Same, for every holder. |
| Ban | registry → lock → revoke auth → claw back all | Idempotent; resumes if interrupted. |

Behavior verified on testnet that callers need to know:

- **A freeze does not stop the issuer on-ledger.** The issuer can still pay a frozen holder, or pay during a global freeze. The module refuses to, so always issue through the module.
- **A frozen holder can still redeem**, i.e. send tokens back to the issuer. This is by protocol design.
- **The lasting barrier behind a ban is the revoked authorization, not the lock.** Without `fixCleanup3_4_0`, which isn't enabled on testnet, a banned holder with a zero balance can delete its locked MPToken and opt in again. The new entry is unauthorized, so payments to it still fail with `tecNO_AUTH`. The ban registry is what stops anyone re-authorizing the address, so in production back `BanRegistry` with your system of record.
- The issuance deliberately never sets Can Escrow, Can Trade or confidential balances. `MptIssuer.attach` refuses issuances that set them, because escrowed, pooled or encrypted balances are out of clawback's reach.
- `reference` is written to the public ledger as a memo. Use opaque case IDs only, never personal data. `reason` stays off-ledger in the ban registry.

## Scripts

```sh
npm test               # unit tests
npm run typecheck
npm run build          # emits dist/
ISSUER_SEED=... ISSUER_ADDRESS=... npm run demo   # full demo on testnet
npm run demo -- --faucet-issuer --result /tmp/r.json   # rehearsal with a throwaway issuer
```

The demo writes holder seeds and the ban registry to `.state/` (git-ignored, mode 0600), and writes `result.json`.
