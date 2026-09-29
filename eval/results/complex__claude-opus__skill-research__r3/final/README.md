# mpt-issuer

Issuer-side compliance controls for a regulated, stablecoin-style **Multi-Purpose Token (MPT)** on the XRP Ledger.
TypeScript (strict), `xrpl` 5.3.0, Node ≥ 24.

| Control | Method | On-ledger mechanism |
|---|---|---|
| Allowlist | `approveHolder`, `revokeApproval` | `tfMPTRequireAuth` + issuer `MPTokenAuthorize` |
| Issue | `issue` | `Payment` from the issuer |
| Clawback | `clawback(addr, amount \| 'all')` | `Clawback` with `Holder` (`tfMPTCanClawback`) |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | `MPTokenIssuanceSet` + `Holder` + `tfMPTLock`/`tfMPTUnlock` |
| Global freeze | `freezeAll`, `unfreezeAll` | `MPTokenIssuanceSet` + `tfMPTLock`/`tfMPTUnlock` |
| Ban | `ban(addr, reason)` | record in `BanRegistry` → lock → unauthorize → claw back all → re-verify |

```ts
import { MptIssuer, TransactionSubmitter, FileBanRegistry, connect, resolveNetwork, walletFromSeed } from 'mpt-issuer'

const client = await connect(resolveNetwork('testnet'))            // refuses a server on the wrong network
const deps = { client, submitter: new TransactionSubmitter(client), banRegistry: new FileBanRegistry('state/bans.json'), onAudit: console.log }
const issuer = await MptIssuer.load(deps, walletFromSeed(process.env.XRPL_ISSUER_SEED!), issuanceId)
await issuer.approveHolder(address, 'KYC case 1234')
await issuer.issue(address, '250.00')
```

Amounts are decimal strings in token units (`"12.50"`). They are converted to integer base units using the issuance's `AssetScale`, with `bigint` math.

## Commands

```sh
cp .env.example .env   # set XRPL_ISSUER_SEED
npm install
npm test               # unit tests
npm run demo           # full testnet walkthrough; writes result.json
```

The demo writes holder seeds to `.secrets/`, and the ban registry and audit log to `state/`. Both directories are git-ignored.

## Behaviour worth knowing (verified against rippled 3.4 source and on testnet)

- **The issuer can still pay a frozen holder, and a frozen holder can still send to the issuer.** The ledger's lock only blocks holder-to-holder transfers, in both directions. `issue()` refuses frozen, unapproved or banned holders and refuses during a global freeze. That check is what makes "frozen holders can't receive" hold. Don't pay holders from the issuer key outside this module.
- **Bans:** the ledger enforces them because the holder is no longer authorized; every payment to them fails with `tecNO_AUTH`. The `BanRegistry` makes sure the module never re-approves them. In production, back it with your compliance database. The file registry is for a single process only.
- **Escrow and DEX trading are not enabled.** Clawback only reaches the *spendable* balance, not escrowed amounts, and TokenEscrow is live on testnet.
- **Issuance settings are permanent.** The DynamicMPT amendment is not enabled on testnet, so flags, metadata and `AssetScale` can't be changed after creation. If DynamicMPT is later enabled, capabilities that were never declared immutable (e.g. CanTrade) could be switched on by the issuer key.
- **Concurrency:** mutating calls are serialized within one `MptIssuer` instance. Run one instance per issuance, or add a distributed lock.
- **Uncertain outcomes:** `TransactionOutcomeUnknownError` means the outcome wasn't known when the submitter gave up. Look up its `hash` before retrying.
