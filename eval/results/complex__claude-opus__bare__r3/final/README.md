# MPT issuer compliance module

Issuer-side controls for a regulated token on the XRP Ledger, built on
Multi-Purpose Tokens (XLS-33). TypeScript (strict) on `xrpl` 5.x.

| Control | Method | On ledger |
|---|---|---|
| Allowlist | `approveHolder`, `revokeApproval` | `lsfMPTRequireAuth`; issuer `MPTokenAuthorize` |
| Issue | `issue` | `Payment` from issuer |
| Clawback | `clawback`, `clawbackAll` | `Clawback` (`lsfMPTCanClawback`) |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | `MPTokenIssuanceSet` + `Holder`, `tfMPTLock`/`tfMPTUnlock` |
| Global freeze | `freezeAll`, `unfreezeAll` | `MPTokenIssuanceSet`, `tfMPTLock`/`tfMPTUnlock` |
| Ban | `ban` | lock → claw back everything → unauthorize, plus a durable `BanRegistry` entry |

```ts
import { Client, Wallet } from 'xrpl'
import { FileBanRegistry, MptIssuer } from './src/index.js'

const issuer = await MptIssuer.load({
  client, wallet: Wallet.fromSeed(seed), issuanceId,
  banRegistry: new FileBanRegistry('data/bans.json'), // use your DB in production
})
await issuer.approveHolder(address)   // after KYC; holder must have opted in first
await issuer.issue(address, '100.25')
await issuer.ban(address, 'sanctions hit')
```

Amounts are decimal strings in display units, converted using the issuance's
`AssetScale` (bigint only). Every write waits for validation and throws
`TransactionFailedError` unless the result is `tesSUCCESS`. Issuer
transactions are serialized per instance. Run one instance per issuer account.

## Scripts

- `npm run demo`: creates an issuance and holders A/B/C on testnet, exercises
  and negative-tests every control, and writes `result.json`. Needs `.env` (see `.env.example`).
  Holder seeds are saved to `.demo-holders.json` (gitignored).
- `npm run verify`: re-checks `result.json` against raw ledger entries.
- `npm test`: unit tests. `npm run typecheck`: TypeScript check.

## Protocol behaviour you need to know (verified on testnet)

- **A lock does not stop the issuer.** The ledger accepts issuer→holder
  payments to a locked holder and during a global lock. `issue()` refuses both
  cases, so this only holds if all payouts go through this module.
- **Locked holders can still redeem to the issuer.** A frozen holder (or any
  holder during a global freeze) can pay tokens back to the issuer, which burns
  them. No value leaves your control, but your off-ledger redemption process
  must refuse to pay out fiat to frozen or banned holders.
- **Ban durability.** On ledger a banned holder is unauthorized, locked and has
  a 0 balance. Even if they delete and re-create their MPToken, they stay
  unauthorized. The ledger has no "banned" flag. The `BanRegistry` is what
  stops the issuer from re-approving them later, so it must be durable.
- **Capability flags are fixed.** `MPTokenIssuanceCreate` sets CanLock,
  RequireAuth, CanClawback, CanTransfer, and leaves CanEscrow, CanTrade and
  confidential balances off, because those move value out of reach of
  clawback. `MptIssuer.load` rejects issuances that don't match. If the
  DynamicMPT amendment is active (it isn't on testnet yet), creation also sets
  `ImmutableFlags` so the flags can never be changed. A `DomainID` would let
  holders in without issuer approval, so `load` rejects that too.
