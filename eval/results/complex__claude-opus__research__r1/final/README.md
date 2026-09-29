# mpt-issuer

Issuer-side compliance controls for a regulated, stablecoin-style
[Multi-Purpose Token (MPT)](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
on the XRP Ledger. TypeScript (strict), `xrpl` 5.3.0.

```ts
import { Client, ECDSA, Wallet } from 'xrpl'
import { JsonFileBanRegistry, MptIssuer } from 'mpt-issuer'

const client = new Client('wss://s.altnet.rippletest.net:51233')
await client.connect()
const wallet = Wallet.fromSeed(seed, { algorithm: ECDSA.ed25519 })
const issuer = await MptIssuer.attach(client, wallet, issuanceId, {
  banRegistry: new JsonFileBanRegistry('data/bans.json'), // use a DB-backed registry in production
})

await issuer.approveHolder(addr)          // allowlist (after KYC; holder must have opted in)
await issuer.issue(addr, '500')           // amounts are integer strings/bigints in the smallest unit
await issuer.clawback(addr, '300')        // or 'all'
await issuer.freezeHolder(addr)           // / unfreezeHolder
await issuer.freezeAll()                  // / unfreezeAll
await issuer.ban(addr, 'reason')          // registry + unauthorize + lock + claw back everything
```

Every action returns a receipt listing the validated transaction hashes. The
receipt's list is empty when the ledger was already in the requested state.
Failures are typed errors: `ComplianceError` (refused before submitting),
`TransactionFailedError` (validated with a non-success code),
`TransactionExpiredError` (proven never to apply, so it's safe to retry) and
`TransactionOutcomeUnknownError` (look the hash up before retrying).

## How each control maps onto the ledger

| Control | Ledger mechanism |
|---|---|
| Allowlist | Issuance created with `tfMPTRequireAuth`; issuer `MPTokenAuthorize` with `Holder`. Unapproved accounts can't send or receive (`tecNO_AUTH`). |
| Clawback | `tfMPTCanClawback`; `Clawback` with `Holder`. Works regardless of freezes and approval. |
| Per-holder freeze | `tfMPTCanLock`; `MPTokenIssuanceSet` + `tfMPTLock`/`tfMPTUnlock` with `Holder`. |
| Global freeze | Same, without `Holder`. |
| Ban | Recorded in the ban registry first, then unauthorize, lock and claw back the full balance. Verified afterwards (balance 0, unapproved, locked). |

The issuance is also created **without** Can Escrow, Can Trade or confidential
balances, and with no permissioned domain. Each of those lets tokens sit
somewhere clawback, freezes or the allowlist can't reach. The module checks
the issuance configuration before every action and refuses to operate on an
issuance that has any of them.

## Protocol behaviour you should know about

These were confirmed against the rippled 3.4 source and on testnet
(`demo-report.json` has the evidence):

1. **Locks only block holder-to-holder transfers.** The ledger still lets the
   issuer pay a frozen holder, and lets a frozen (but approved) holder pay the
   issuer. The module closes the first gap: `issue()` refuses frozen holders
   and refuses everyone during a global freeze. The second gap is protocol
   behaviour (the same as trust-line deep freeze). A frozen holder can still
   redeem (burn) tokens back to the issuer. If that is unacceptable for a
   case, use `revokeApproval()` as well, or `ban()`. Unapproved holders can't
   send to anyone, including the issuer.
2. **"Banned" isn't a ledger state.** On-ledger, a banned holder is simply
   unapproved and locked. Until the `fixCleanup3_4_0` amendment is enabled
   (it isn't on testnet yet), a banned holder can delete their empty, locked
   MPToken and create a new, unapproved one. They still can't receive the
   token. The ban registry is what stops the issuer re-approving them, so
   back it with durable storage.
3. **DynamicMPT** (not yet enabled on testnet) makes issuance flags mutable by
   default. `createIssuance` detects the amendment and, when it's enabled,
   sets `ImmutableFlags` so the compliance configuration can never change.
   Issuances created before the amendment should be reviewed once it activates.

## Operational notes

- Run **one** `MptIssuer` per issuer key. Submissions are serialised in
  process; a second process signing for the same account would race for
  Sequence numbers.
- All reads use the latest *validated* ledger. Success means "validated with
  `tesSUCCESS`", never just "accepted by the server".
- For production, keep the master key offline and sign with a regular key or
  multi-signing held in an HSM/KMS. The `Wallet` passed in here is the only
  signing dependency.

## Demo

```sh
cp .env.example .env      # set ISSUER_SEED (and optionally ISSUER_ADDRESS)
npm install
npm test                  # unit tests (node:test)
npm run demo              # testnet only; refuses any other network
```

The demo funds three new holder accounts (5 XRP each) from the issuer, creates
a new issuance and exercises every control. For each control it shows both
the ledger rejecting forbidden moves and the module refusing unsafe issuer
actions. It then verifies the final state and writes `result.json` and
`demo-report.json` (every step and transaction hash). Each run creates a new
issuance and new holders.
