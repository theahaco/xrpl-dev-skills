# MPT compliance issuer

Issuer-side compliance controls for a regulated, stablecoin-style XRPL Multi-Purpose Token (MPT):
allowlist, clawback, bans, per-holder freeze and global freeze.

```ts
import { Client, Wallet } from 'xrpl'
import { MptIssuer, JsonFileBanStore } from './src/index.js'

const issuer = await MptIssuer.load(client, Wallet.fromSeed(seed), issuanceId, {
  banStore: new JsonFileBanStore('data/bans.json'), // replace with your system of record
  audit: async (event) => { /* write to your audit log */ },
})

await issuer.approveHolder(address)        // allowlist (holder must have opted in first)
await issuer.issue(address, 500n)          // amounts are integer base units
await issuer.clawback(address, 300n)
await issuer.freezeHolder(address); await issuer.unfreezeHolder(address)
await issuer.freezeAll();           await issuer.unfreezeAll()
await issuer.ban(address, 'reason')        // unapprove + claw back everything + refuse forever
```

`MptIssuer.create(...)` creates a new issuance with RequireAuth, CanLock, CanClawback and
(optionally) CanTransfer. Escrow, DEX trading and confidential balances stay off, because those
would let balances get beyond the reach of clawback. `load` and the sensitive operations check
that configuration on the ledger and refuse to work with an issuance that doesn't match.

## Guarantees and caveats

- Every mutating call waits for a validated ledger result and throws `TransactionFailedError`
  (with the `tec…`/`tem…` code) on anything but `tesSUCCESS`. `TransactionOutcomeUnknownError`
  means the outcome could not be determined. Reconcile using its `hash` before retrying.
- Calls are serialized per issuer account **within one process**. Don't sign with the issuer key
  from two processes at once.
- **Bans** are recorded in the `BanStore` first, then enforced on the ledger (approval revoked,
  full balance clawed back, then re-verified). The ledger can't tell "banned" apart from "not yet
  approved", so the ban store is the source of truth and must be durable and shared by everything
  that approves holders. If `ban()` throws `BanEnforcementError`, call it again to resume.
- **Freezes (XRPL design):** the ledger's MPT lock blocks holder↔holder transfers only. It does
  not stop the issuer paying a frozen holder (`issue()` refuses this itself), and it does not stop
  a frozen holder sending tokens back to the issuer. Redemption processing must check
  `getHolderState()` and not pay out for tokens returned by a frozen holder.

## Scripts

- `npm test`: unit tests
- `npm run typecheck`
- `npm run demo`: exercises every control on testnet (needs `.env` with `ISSUER_SEED`),
  verifies the final ledger state and writes `result.json`. Holder seeds, the ban list and the
  audit log go to `data/` (gitignored).
