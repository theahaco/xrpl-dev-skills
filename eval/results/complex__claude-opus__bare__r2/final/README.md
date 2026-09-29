# mpt-issuer

Issuer-side compliance controls for a regulated, stablecoin-style
Multi-Purpose Token (MPT) on the XRP Ledger. TypeScript (strict), `xrpl` 5.3.

| Control | Method(s) | Enforced by |
|---|---|---|
| Allowlist (KYC) | `approveHolder`, `revokeApproval` | Ledger (`RequireAuth`) |
| Clawback | `clawback` | Ledger (`CanClawback`) |
| Ban | `ban` | Ledger (freeze + de-authorize + clawback) **and** the ban registry |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | Ledger (`CanLock`) + module (see caveats) |
| Global freeze | `freezeGlobal`, `unfreezeGlobal` | Ledger (`CanLock`) + module (see caveats) |

## Usage

```ts
import { Client, Wallet } from 'xrpl'
import { FileBanRegistry, MptIssuer } from './src/index.js'

const client = new Client('wss://s.altnet.rippletest.net:51233')
await client.connect()
const issuer = await MptIssuer.attach(client, Wallet.fromSeed(process.env.ISSUER_SEED!), issuanceId, {
  banRegistry: new FileBanRegistry('data/bans.json'), // use your compliance DB in production
  audit: async (event) => { /* persist to your audit store */ },
  logger: console,
})

await issuer.approveHolder(addr)          // after KYC; holder must have opted in first
await issuer.issue(addr, 1_000n)          // integer base units (10^AssetScale per token)
await issuer.freezeHolder(addr)
await issuer.clawback(addr, 300n)
await issuer.ban(addr, 'sanctions hit')   // permanent; idempotent; verifies end state
await issuer.freezeGlobal()
```

`MptIssuer.create(...)` creates a new issuance with the required flags.
`MptIssuer.attach(...)` refuses to operate an existing issuance that lacks a control or has an escape hatch
(see `src/policy.ts`).

All amounts are integer **base units** (`bigint | number | string`). Fractions, exponents and unsafe numbers are rejected.

### Errors

| Error | Meaning | Anything on-ledger? |
|---|---|---|
| `InvalidInputError` | Bad address or amount | No |
| `ComplianceError` (`.reason`) | Policy refused, e.g. `HOLDER_BANNED`, `HOLDER_FROZEN` | No |
| `IssuanceConfigError` | Issuance lacks required controls | No |
| `TransactionFailedError` (`.engineResult`) | Definitively not applied (`tec…` validated, `tem…`, or `EXPIRED`) | No state change |
| `OutcomeUnknownError` (`.hash`) | Couldn't confirm the outcome | **Maybe.** Look the hash up before retrying |

State-changing methods are idempotent where it makes sense (approve, freeze, unfreeze, ban). They return
`{ changed: false }` without submitting if the ledger is already in the requested state. `issue` and
`clawback` are not idempotent: never retry them after `OutcomeUnknownError` without checking the hash.

## Design decisions (read before going to production)

**Issuance flags.** `CanLock | RequireAuth | CanClawback | CanTransfer`. We deliberately leave out
`CanEscrow`, `CanTrade` and `CanHoldConfidentialBalance`. Escrowed, DEX/AMM-held or encrypted balances
would sit outside the holder balance that clawback and ban act on. No `DomainID` is ever set: with one,
anyone holding the domain's credentials counts as authorized, which would bypass both the allowlist and bans.
On testnet today (rippled 3.4.1) `DynamicMPT` is **not** enabled, so these flags are fixed at creation.
When it is enabled, `create()` also pins them with `ImmutableFlags`. `attach()` and
`assertCompliantIssuance()` re-check the live configuration either way.

**Bans.** The ledger has no "banned" state. A ban is carried out as: record in the ban registry (durable,
first) → freeze → revoke authorization → claw back the whole balance → verify on a validated ledger.
Revoking authorization is what makes it airtight. We verified on testnet that an unauthorized holder can't
send or receive at all, not even to the issuer. If the holder deletes their MPToken and creates it again, it comes
back unauthorized. The registry stops the backend from ever re-approving the address. `unfreezeHolder` also
refuses banned addresses. There is intentionally no `unban` method; lifting a ban is a deliberate
registry change followed by `approveHolder`.

**Freeze caveats (protocol behaviour, verified on testnet).** A per-holder or global lock blocks all
holder-to-holder transfers (`tecLOCKED`), but the ledger still allows **issuer ↔ holder** payments:
- *Issuer → frozen holder:* the ledger allows it; `issue()` refuses (`HOLDER_FROZEN` / `GLOBALLY_FROZEN`).
  Don't send issuer payments that bypass this module.
- *Frozen holder → issuer* (redemption): the ledger allows it and the issuer can't block it with a lock.
  If you must also stop redemptions, use `revokeApproval` (or `ban`) instead.
- Clawback works on frozen holders and during a global freeze.

**Transaction submission.** The flow is sign locally → submit → poll until validated or until
`LastLedgerSequence` has passed a validated ledger. Only then is a result final. `tec` rejections land on-ledger and
are reported with their code. Submissions are serialized per process. **Run exactly one writer per
issuing key**, because concurrent processes will collide on sequence numbers.

**Key management.** The demo reads `ISSUER_SEED` from `.env` for testnet convenience. In production the
issuer key belongs in an HSM/KMS or a multi-signing setup. Consider a regular key or a multisig
signer list on the issuer account, with the master key disabled.

## Scripts

```sh
npm install
cp .env.example .env   # set ISSUER_SEED (and optionally ISSUER_ADDRESS)
npm test               # unit tests (no network)
npm run typecheck
npm run demo           # testnet end-to-end demo; writes result.json
```

The demo creates and funds three holder accounts (5 XRP each) and saves their keys to
`holders.<timestamp>.local.json` (gitignored). It exercises every control with positive and negative checks
(ledger rejections *and* policy refusals), verifies the final ledger state, and only then writes `result.json`.
Audit events go to `data/audit.jsonl` and bans to `data/bans.json`.

## Layout

```
src/issuer.ts         MptIssuer: all issuer controls
src/policy.ts         required / forbidden issuance flags, config checks
src/submitter.ts      reliable, serialized transaction submission
src/ban-registry.ts   BanRegistry interface + file / in-memory implementations
src/holder.ts         holder-side helper (opt-in, transfers), used by the demo
src/ledger.ts         ledger reads and metadata parsing
scripts/demo.ts       testnet demo
test/unit.test.ts     unit tests
```
