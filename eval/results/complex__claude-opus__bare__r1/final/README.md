# MPT stablecoin issuer

Issuer-side compliance controls for a regulated Multi-Purpose Token (MPT) on the XRP Ledger, in TypeScript on `xrpl` 5.3.

## Controls

| Control | API | Enforced by |
|---|---|---|
| Allowlist (KYC) | `approveHolder`, `revokeHolder` | Ledger (`tfMPTRequireAuth`): unapproved accounts cannot send or receive. |
| Clawback | `clawback(holder, amount, reason)` | Ledger (`tfMPTCanClawback`). Works on frozen, unapproved and banned holders, and during a global freeze. |
| Ban | `ban(holder, reason)` | Ledger + ban registry (see below). |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | Ledger blocks transfers between holders; the module blocks issuance to frozen holders. |
| Global freeze | `freezeAll`, `unfreezeAll` | Ledger blocks all transfers between holders; the module blocks all issuance. |

Issuances are created with **lock, require-auth, clawback and transfer** enabled, and with **escrow, DEX/AMM trading and confidential balances disabled**. Tokens in escrow, AMM pools or confidential balances can't be clawed back, so they would defeat a ban. `MptIssuer.load()` refuses any issuance that lacks a required control, enables one of those capabilities, or delegates authorization to a permissioned domain.

## Usage

```ts
import { Client, Wallet } from 'xrpl'
import { JsonFileBanRegistry, MptIssuer } from './src/index.js'

const client = new Client('wss://s.altnet.rippletest.net:51233')
await client.connect()
const issuer = await MptIssuer.load(
  {
    client,
    signer: Wallet.fromSeed(process.env.ISSUER_SEED!), // or any KMS/HSM-backed `Signer`
    banRegistry: new JsonFileBanRegistry('data/bans.json'), // use your database in production
    expectedNetworkId: 1, // refuse to run against any other network
    audit: (event) => auditLog.write(event), // called for every action, including refusals
  },
  issuanceId,
)

await issuer.approveHolder(address, { reference: 'KYC-123', actor: 'ops@company' })
await issuer.issue(address, '100.00')
await issuer.freezeHolder(address, 'Suspicious activity', { reference: 'CASE-9' })
await issuer.ban(address, 'Sanctions match')
```

Amounts are decimal **strings** and are checked against the token's `AssetScale`. JavaScript numbers are rejected.

## Semantics worth knowing

These were verified against rippled 3.4.1 on testnet.

- **What a freeze blocks.** An MPT lock blocks transfers between holders only. The ledger still allows (a) the issuer to pay a frozen holder, and (b) a frozen holder to send tokens back to the issuer, which redeems them. This module never does (a). Nothing on-ledger can stop (b), and it only ever returns tokens to you.
- **How a ban is made permanent.** The ban is written to the registry first. Then the module revokes approval, claws back the full balance, and freezes the holder. Finally it checks the validated ledger. After a ban, the ledger rejects all transfers to or from the address with `tecNO_AUTH`, including after the holder deletes its MPToken and opts in again. On-ledger, though, a banned address looks the same as one that was never approved. So the **ban registry is what stops the address from being approved again**. It must be durable and shared by every backend instance that can call `approveHolder`. `ban()` is idempotent: if it fails part-way, run it again.
- **Revoking approval without a ban** (`revokeHolder`) leaves any balance immobilized, even for sends back to the issuer, until you approve the holder again or claw the balance back.
- **Concurrency.** Each `MptIssuer` runs its actions one at a time. This avoids sequence-number collisions and keeps each check-then-submit atomic. Run **one** issuer process per issuing account, or put a distributed lock in front of it.
- **Transaction outcomes** come back as distinct errors:
  - `TransactionFailedError`: validated `tec*`, nothing changed.
  - `TransactionNotAppliedError`: definitely not applied, so retrying is safe.
  - `TransactionOutcomeUnknownError`: check the tx hash before retrying.
  - `ComplianceViolationError` / `InvalidInputError`: refused before anything was submitted.
- **Immutability.** The DynamicMPT amendment is not enabled on testnet, so issuance capabilities are fixed at creation. Re-check this before mainnet if DynamicMPT has been enabled there.

## Scripts

```sh
cp .env.example .env   # set ISSUER_SEED
npm test               # offline unit tests
npm run typecheck
npm run demo           # full testnet demo; writes result.json, data/bans.json, data/audit-log.json
```

The demo generates three holder wallets. Their testnet seeds are saved to `.demo-wallets.json`, which is gitignored.
