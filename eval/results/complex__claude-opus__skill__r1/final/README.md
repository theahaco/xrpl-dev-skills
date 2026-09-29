# XRPL MPT issuer: compliance-controlled token

TypeScript module (strict mode, `xrpl` v5) for issuing a regulated, stablecoin-style
[Multi-Purpose Token](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
with allowlist, clawback, bans, per-holder freeze and global freeze. There's also a testnet demo
that exercises every control.

```
src/
  issuer.ts     MptIssuer: the backend-facing issuer API
  registry.ts   ComplianceRegistry (ban list): interface + in-memory and JSON-file implementations
  submit.ts     Reliable submission: sign, submit, wait for a final validated outcome
  holder.ts     Holder-side helpers (opt-in, transfer), used by the demo and tests
  errors.ts     Typed errors
  amounts.ts    Amount and ID validation
scripts/
  demo.ts       Runs every control against testnet and writes result.json
  verify.ts     Re-checks the demo's end state on the ledger (no secrets needed)
test/           Unit tests (node:test)
```

## Usage

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer, JsonFileComplianceRegistry } from './src/index.js';

const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const wallet = Wallet.fromSeed(process.env.ISSUER_SEED!);
const registry = await JsonFileComplianceRegistry.open('.data/compliance-registry.json');
const options = { registry, onAudit: (e) => auditLog.write(e) };

// One-time: create the issuance. Flags are immutable, so every control is enabled here.
const { issuer } = await MptIssuer.createIssuance(client, wallet, { assetScale: 0, metadata }, options);
// Later: attach to an existing issuance (checks the issuer and the flags on the ledger).
const issuer2 = await MptIssuer.connect(client, wallet, issuanceId, options);

await issuer.authorizeHolder(addr);     // allowlist (after KYC; holder must have opted in first)
await issuer.revokeHolder(addr);        // remove from allowlist
await issuer.issue(addr, 500n);         // mint to a holder
await issuer.clawback(addr, 300n);      // or clawbackAll(addr)
await issuer.freezeHolder(addr);        // unfreezeHolder(addr)
await issuer.freezeGlobal();            // unfreezeGlobal()
await issuer.ban(addr, 'reason');       // freeze + de-authorize + claw back everything, permanently
```

Amounts are **base units** (ledger integers, before `AssetScale`), passed as `bigint` or
digit strings. JS numbers aren't accepted because they lose precision.

## How each control maps to the ledger

| Control | Ledger mechanism |
|---|---|
| Allowlist | Issuance flag `RequireAuth`. The issuer's `MPTokenAuthorize` (with `Holder`) sets or clears `lsfMPTAuthorized` on the holder's `MPToken`. Unauthorized holders can't send or receive, not even to or from the issuer. |
| Clawback | Flag `CanClawback` plus a `Clawback` transaction. Works even when the holder or the whole token is frozen. |
| Per-holder freeze | Flag `CanLock`. `MPTokenIssuanceSet` with `Holder` and `tfMPTLock` / `tfMPTUnlock`. |
| Global freeze | `MPTokenIssuanceSet` without `Holder`, using `tfMPTLock` / `tfMPTUnlock`. |
| Ban | Records the address in the `ComplianceRegistry`, then freezes the holder, de-authorizes them, claws back the full balance, and checks the result on the validated ledger. |

Holder-to-holder transfers are enabled (`CanTransfer`). `CanEscrow`, `CanTrade` and
`CanHoldConfidentialBalance` are **deliberately off**, and `connect()` refuses issuances that
have them. Each one lets tokens sit somewhere clawback can't reach (escrow, DEX/AMM,
encrypted balances), which would break the guarantee that a banned holder ends with zero.
MPT flags are immutable (the `DynamicMPT` amendment isn't enabled on testnet), so this can't
be changed later without a new issuance.

### Why bans need the registry

On the ledger, a banned holder is de-authorized, and `RequireAuth` stops them receiving the
token again. That still holds if they delete their `MPToken` and opt in again (the demo
checks this). The one thing that could undo a ban is the issuer re-authorizing the address.
So `authorizeHolder`, `issue` and `unfreezeHolder` refuse any address in the registry. `ban`
writes to the registry *before* it touches the ledger, so a ban that fails part-way still
blocks the address. `ban` is idempotent, so you can re-run it after a partial failure.

In production, implement `ComplianceRegistry` on the same database as your KYC decisions. The
JSON-file implementation is for a single process only.

### Freeze and redemption (known XRPL behaviour)

On XRPL, a lock (per-holder or global) **does not stop a holder paying the token back to
the issuer**. Transfers between holders, and issuance to holders, are blocked (`tecLOCKED`).
We confirmed this on testnet, and the demo shows it on purpose. The tokens go back to the
issuer and leave circulation. The risk is off-ledger: **your redemption and payout process
must check freeze status and must not pay out for tokens received while the holder or token
was frozen.** Revoking a holder's authorization does block redemption, which is why `ban`
de-authorizes before it claws back.

## Operational notes

- **Submission** (`submit.ts`): the transaction hash is computed before submission. A
  transaction counts as expired only once a lookup of its whole `LastLedgerSequence` window
  (with `searched_all`) proves it was never included. xrpl.js's `submitAndWait` can report a
  transaction that validated in its final ledger as failed; this avoids that.
  `TransactionOutcomeUnknownError` means the transaction *may* have been applied, so look up
  the hash before retrying.
- **Concurrency:** operations on one `MptIssuer` instance run one at a time. Run a single
  instance per issuer account, or put a distributed lock in front of it, or sequence numbers
  will collide.
- **Audit:** `onAudit` is called for every transaction, successful or not, with the operation,
  holder, amount, hash, result code and ledger. `onAudit` shouldn't throw.
- **Keys:** the issuer seed is read from the environment. For production (mainnet), use a
  hardware- or KMS-backed signer, and consider a multi-signature list and a regular key.
- **Metadata** is validated strictly against XLS-89. Any warning is an error.

## Running

```sh
npm install
cp .env.example .env         # set ISSUER_SEED / ISSUER_ADDRESS
npm run typecheck && npm test
npm run demo                 # creates a NEW issuance + 3 funded holders; writes result.json
npm run verify               # re-checks the end state from result.json
```

The demo saves holder seeds to `.data/holders.json` before funding them. It also writes the
ban registry and an audit log to `.data/`. That directory is git-ignored and holds secrets.
