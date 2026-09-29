# MPT compliance issuer

Issuer-side controls for a regulated, stablecoin-style [Multi-Purpose Token](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) on the XRP Ledger.

Built against `xrpl` 5.3.0 and rippled 3.4.x on testnet (`MPTokensV1`, `Clawback`, `TokenEscrow` enabled; `DynamicMPT`, `SingleAssetVault`, `ConfidentialTransfer`, `fixCleanup3_4_0` not enabled as of 2026-09-29).

## Usage

```ts
import { Client, ECDSA, Wallet } from 'xrpl'
import { JsonFileBanRegistry, MptIssuer } from './src/index.js'

const client = new Client('wss://s.altnet.rippletest.net:51233')
await client.connect()
const wallet = Wallet.fromSeed(process.env.ISSUER_SEED!, { algorithm: ECDSA.ed25519 })
const issuer = await MptIssuer.attach(client, wallet, issuanceId, {
  banRegistry: new JsonFileBanRegistry('state/ban-registry.json'), // use your compliance DB in production
  expectedNetworkId: 1,
  onAudit: (e) => auditLog.write(e),
})

await issuer.approveHolder(addr)          // allowlist (after KYC; holder must opt in first)
await issuer.issue(addr, '100.25')        // amounts are decimal strings in token units
await issuer.clawback(addr, '40')
await issuer.freezeHolder(addr); await issuer.unfreezeHolder(addr)
await issuer.freezeAll();        await issuer.unfreezeAll()
await issuer.banHolder(addr, 'reason')    // durable ban + revoke + freeze + claw back everything
```

Use `MptIssuer.create(...)` to create a new issuance.

## Control semantics

| Control | On ledger | Enforced by this module in addition |
|---|---|---|
| Allowlist | `tfMPTRequireAuth`: unapproved holders can neither send nor receive (`tecNO_AUTH`). | |
| Clawback | `tfMPTCanClawback`: works whatever the holder's approval or freeze state. | Returns the amount actually removed. |
| Per-holder freeze | `MPTokenIssuanceSet` + `Holder`: blocks transfers to or from other holders (`tecLOCKED`). | Refuses to issue to a frozen holder. |
| Global freeze | `MPTokenIssuanceSet` (no `Holder`): blocks all holder-to-holder transfers. | Refuses all issuance while frozen. |
| Ban | Revoke approval + lock + claw back the full balance. | A durable ban list blocks re-approval, issuance and unfreezing. |

Important ledger behaviours to know:

- **A lock does not block the issuer.** The ledger still accepts issuer→holder payments to a locked holder, even during a global freeze. It also lets a locked holder send tokens back to the issuer (redemption). The module's guards close the issuer→holder gap, but only for payments sent through this module.
- **Bans need the off-ledger list.** A banned holder can delete their empty MPToken entry and create a new one. The new entry starts unapproved, so the ledger still blocks it. After that point, only the ban list stops someone from approving the holder again.
- **Settings the module refuses.** `MptIssuer.attach` refuses any issuance that enables escrow, DEX trading or confidential balances, or that has a permissioned `DomainID`. Escrow, trading and confidential balances let value move out of clawback's reach. A permissioned domain lets anyone with its credentials hold the token without approval.
- **DynamicMPT is not yet enabled.** Once it is enabled on a network, capability flags can be switched on after creation. They cannot be switched off. Consider declaring them immutable at that point.

## Operations

- Only one process should sign for the issuer at a time. Submissions are serialized per account within a process.
- `TransactionOutcomeUnknownError` means the result could not be proven. Look the transaction up by hash before retrying.
- Secrets live in `.env` and `.secrets/`, which are git-ignored. Operational state (ban list and audit log) lives in `state/`.

## Scripts

- `npm test`: offline unit tests
- `npm run typecheck`
- `npm run demo`: full run on testnet; writes `result.json`
