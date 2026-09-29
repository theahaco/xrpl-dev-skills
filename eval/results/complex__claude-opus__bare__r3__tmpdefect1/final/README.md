# mpt-issuer

Issuer-side compliance controls for a regulated stablecoin issued as an XRPL
Multi-Purpose Token (MPT). TypeScript (strict), built on `xrpl` 5.x.

```
npm install
npm run typecheck
npm run build        # emits dist/
npm run demo         # runs scripts/demo.ts against testnet; needs ISSUER_SEED (.env)
```

## Controls

| Control | How it is enforced |
|---|---|
| **Allowlist** | Issuance created with `tfMPTRequireAuth`. A holder opts in (`MPTokenAuthorize` signed by the holder), then the issuer approves them with `authorizeHolder()`. The ledger rejects payments to or from unapproved holders (`tecNO_AUTH`). |
| **Clawback** | `tfMPTCanClawback`. `clawback(holder, amount)` claws back exactly `amount` and refuses if the holder has less; `clawbackAll(holder)` empties the balance. Works on frozen and unauthorized holders. |
| **Per-holder freeze** | `tfMPTCanLock`. `freezeHolder()` / `unfreezeHolder()` (`MPTokenIssuanceSet` + `Holder`, `tfMPTLock`/`tfMPTUnlock`). |
| **Global freeze** | `freezeAll()` / `unfreezeAll()` (same, without `Holder`). Per-holder freezes survive a global unfreeze. |
| **Ban** | `ban(holder, reason)`: record in the `BanRegistry`, freeze, revoke authorization, claw back the full balance, then verify on the ledger. Idempotent and resumable; `enforceAllBans()` reconciles. |

The issuance flags are fixed at creation (testnet doesn't have the `DynamicMPT`
amendment enabled). `MptIssuer.open()` refuses issuances that are missing a
required control or that enable escrow, DEX trading, or confidential balances.
All three could move tokens out of the issuer's reach: escrowed amounts can't
be clawed back, and confidential balances hide amounts from the issuer.

### Ledger behaviour you need to know (verified on testnet, rippled 3.4.1)

- **MPT locks do not apply to payments to or from the issuer.** The ledger
  blocks holder-to-holder payments involving a frozen holder (or any holder
  during a global freeze) with `tecLOCKED`. It still accepts:
  - **issuer → frozen holder.** `issue()` refuses this (frozen holder or
    global freeze), so it is safe as long as every issuer payment goes through
    this module.
  - **frozen holder → issuer.** A frozen holder can still send tokens back to
    the issuer. The module can't prevent this. **Redemption processing must
    check `getHolderState(addr).frozen` (and `getIssuanceState().globallyFrozen`)
    before paying out fiat**, and hold funds for frozen holders.
- **Why bans hold:** after a ban, the holder's MPToken is unauthorized.
  Deleting and recreating the MPToken (tested) produces a new, unauthorized
  entry, so the ledger still rejects every payment to them (`tecNO_AUTH`). The
  ledger would let the *issuer* re-authorize them, which is why the
  `BanRegistry` exists and why `authorizeHolder`, `issue` and `unfreezeHolder`
  refuse banned addresses. In production, back `BanRegistry` with your
  compliance database. `FileBanRegistry` is single-process only.

## Using the module

```ts
import { Client, Wallet } from 'xrpl'
import { MptIssuer, FileBanRegistry } from 'mpt-issuer'

const issuer = await MptIssuer.open({
  client, issuerWallet, issuanceId,
  banRegistry: new FileBanRegistry('/var/lib/mpt/bans.json'),
  logger, // AuditLogger: ship to your audit trail
})
await issuer.authorizeHolder(addr)      // after KYC; holder must have opted in
await issuer.issue(addr, 1_000n)        // base units (see assetScale)
await issuer.freezeHolder(addr)
await issuer.ban(addr, 'case #1234')
```

- Amounts are integers in base units (`bigint` or digit string). With
  `assetScale: 2`, `12345n` is 123.45 tokens. The demo uses `assetScale: 0`,
  so 1 base unit = 1 token.
- Every mutating call resolves only when its transaction is validated with
  `tesSUCCESS`. It returns `{ changed: false }` if the ledger was already in the
  requested state. It throws `TransactionFailedError` (definitive failure, safe to
  retry), `SubmissionOutcomeUnknownError` (**look up the hash before retrying**),
  `PolicyViolationError`, `LedgerStateError` or `InvalidArgumentError`.
- Transactions from one account are serialized in-process, so concurrent calls
  don't collide on `Sequence`. Run a single issuer process (or add a distributed
  lock); two processes signing for the same account will conflict.
- The issuer seed is read by the caller. In production, sign with a KMS/HSM
  or multisig rather than a raw seed in an env var.

## Demo (`scripts/demo.ts`)

Creates the issuance and funds holders A, B, C from the issuer. It then runs
each control and asserts the ledger state after every step. Negative checks go
straight to the ledger (bypassing the module) where possible, to show the
ledger itself enforces them. Output from the testnet run is in
`demo-output.log`; the result is in `result.json`. Holder seeds for the demo
are written to `.demo-holders.json` (gitignored, testnet only).
