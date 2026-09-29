# MPT issuer: compliance controls for a regulated token on the XRP Ledger

A TypeScript module (`src/`) that your backend uses to run a stablecoin-style Multi-Purpose Token (MPT) from the issuer side. It also includes a testnet demo (`scripts/demo.ts`) and a read-only verifier (`scripts/verify.ts`).

```bash
npm install
npm test                                            # offline unit tests
npm run typecheck
XRPL_ISSUER_SEED=s... XRPL_ISSUER_ADDRESS=r... npm run demo   # testnet only; refuses other networks
XRPL_ISSUER_ADDRESS=r... npm run verify             # re-check result.json against the ledger, no keys needed
```

## Controls

| Control | API | On-ledger mechanism |
|---|---|---|
| Allowlist | `approveHolder`, `revokeApproval` | `tfMPTRequireAuth` + issuer `MPTokenAuthorize` |
| Clawback | `clawback(holder, amount)` | `tfMPTCanClawback` + `Clawback` with `Holder` |
| Ban | `ban(holder, reason)` | ban registry, then revoke approval, then claw back the full balance |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | `tfMPTCanLock` + `MPTokenIssuanceSet` with `Holder` |
| Global freeze | `freezeAll`, `unfreezeAll` | `tfMPTCanLock` + `MPTokenIssuanceSet` |
| Redemption guard | `assessRedemption(txHash)` | reads freeze and ban state at the ledger where the redemption landed |

```ts
import { Client, Wallet } from 'xrpl'
import { FileBanRegistry, MptIssuer } from 'mpt-issuer'

const issuer = await MptIssuer.load({
  client, issuerWallet, issuanceId,
  banRegistry: new FileBanRegistry('/var/lib/issuer/bans.json'), // or your own DB-backed BanRegistry
  onAudit: (entry) => auditLog.write(entry),
})
await issuer.approveHolder(address, { reference: 'KYC-1234' })
await issuer.issue(address, 500n)
```

Amounts are integer **base units** (`bigint` or digit string). Use `toBaseUnits('12.34', assetScale)` to convert. The demo uses `AssetScale: 0`, so 500 on the ledger means 500 tokens. A production stablecoin will usually use 2 or 6.

## What the ledger enforces, and what it doesn't

These results were measured on testnet (rippled 3.4.1):

| Movement | Holder frozen | Global freeze | Holder unapproved |
|---|---|---|---|
| holder → holder | blocked (`tecLOCKED`) | blocked (`tecLOCKED`) | blocked (`tecNO_AUTH`) |
| issuer → holder | **allowed** | **allowed** | blocked (`tecNO_AUTH`) |
| holder → issuer (redeem) | **allowed** | **allowed** | blocked (`tecNO_AUTH`) |
| issuer clawback | allowed | allowed | allowed |

That leaves two gaps, and the module closes each of them:

- **Issuer → frozen holder.** Only the issuer key can sign these payments, so `issue()` refuses to pay frozen holders and refuses everything during a global freeze.
- **Frozen holder → issuer.** The ledger can't block this, but tokens sent to the issuer are burned, so no value leaves the system unless your backend pays out fiat. **Your redemption processor must call `assessRedemption(txHash)` and pay out only when `payoutAllowed` is true.** (An alternative is `DepositAuth` on the issuer account plus a `DepositPreauth` per holder. That moves the block on-ledger, but it costs reserve per holder and affects the whole account.)

## Design notes

- **Issuance flags.** The issuance is created with `CanLock | RequireAuth | CanClawback | CanTransfer`. `CanEscrow`, `CanTrade` and confidential balances are deliberately left off: clawback can't reach escrowed or encrypted balances, so a banned holder could keep them. `MptIssuer.load` refuses issuances that don't match this.
- **DynamicMPT.** DynamicMPT is not enabled on testnet yet, so issuance flags can't be changed after creation. When the amendment is live, `createIssuance` also sets `ImmutableFlags` so the controls stay pinned. That branch hasn't run yet because testnet doesn't support it. Existing issuances should be reviewed when the amendment activates.
- **Bans.** The ledger can't tell "banned" apart from "not approved". The ban registry is what stops re-approval, and it's written before any ledger step, so an interrupted ban is still permanent. `ban()` is idempotent: re-run it to finish. There's intentionally no unban API; lifting a ban should be a separate, reviewed process.
- **Serialization.** Each `MptIssuer` instance runs its writes one at a time, which prevents sequence collisions and races such as an approval landing mid-ban. Run one instance per issuer account, or add a distributed lock plus a shared `BanRegistry`.
- **Submission.** `submitAndConfirm` signs locally and waits for a *validated* result. It reports a transaction as expired only after proving it isn't in any ledger up to `LastLedgerSequence`. `TransactionOutcomeUnknownError` means "check the hash before retrying".
- **Memos.** Every transaction carries a memo `mpt-issuer/<operation>`, plus the optional `reference`. Memos are public: never put personal data in them.
- **Keys.** The issuer seed is read from the environment. In production, sign with an HSM/KMS or a multisig/regular-key setup rather than a raw seed.

## Demo output

- `result.json` – issuance ID and holder addresses.
- `demo-run.json` – every step with its transaction hash, including the rejected probes.
- `.demo-wallets.json` (gitignored, mode 600) – testnet seeds for A, B and C.
- `data/bans-<issuanceId>.json` (gitignored) – the ban registry.
