# MPT issuer: compliance controls for a regulated XRPL token

A TypeScript module (strict mode, `xrpl@5.3.0`) for the issuer side of a regulated Multi-Purpose Token (MPT) on the XRP Ledger, plus a demo that exercises every control on testnet.

```bash
npm install
cp .env.example .env      # set ISSUER_SEED (and ISSUER_ADDRESS as a safety check)
npm test                  # offline unit tests
npm run typecheck
npm run demo              # full testnet run; writes result.json
```

## Controls and how they are enforced

| Control | On-ledger mechanism | Module method(s) |
|---|---|---|
| Allowlist | Issuance created with `RequireAuth`. The holder opts in (`MPTokenAuthorize`), then the issuer approves (`MPTokenAuthorize` + `Holder`). | `authorizeHolder(addr, { kycReference })`, `revokeHolder` |
| Clawback | Issuance created with `CanClawback`, then a `Clawback` transaction. | `clawback(addr, amount, { reason })` |
| Ban | Ban recorded in `BanRegistry` → issuer un-authorizes the holder (`tfMPTUnauthorize`) → claws back the full balance → verified. | `banHolder(addr, { reason })`, `assertBanEnforced` |
| Per-holder freeze | `MPTokenIssuanceSet` + `Holder` + `tfMPTLock` / `tfMPTUnlock` (requires `CanLock`). | `freezeHolder`, `unfreezeHolder` |
| Global freeze | `MPTokenIssuanceSet` + `tfMPTLock` / `tfMPTUnlock` on the issuance. | `freezeAll`, `unfreezeAll` |

Issuances are created with exactly `RequireAuth | CanLock | CanClawback | CanTransfer`. `CanEscrow`, `CanTrade` and confidential balances are deliberately off, because they let tokens sit where these controls work differently. `MptIssuer.connect()` refuses an issuance that doesn't match this policy. MPT flags cannot be changed after creation (the `DynamicMPT` amendment is not enabled on testnet).

## Protocol behaviour the design depends on

Verified on testnet (rippled 3.4.1):

- **Freeze does not stop the issuer.** A locked holder, or a globally locked token, still **accepts payments from the issuer**, and the holder can still **send tokens back to the issuer**. Only holder-to-holder transfers fail (`tecLOCKED`). `issue()` therefore refuses to send to a frozen holder or during a global freeze. Redemption to the issuer during a freeze cannot be blocked on-ledger.
- **Un-authorizing works with a balance**, and it blocks sending and receiving, *including from the issuer* (`tecNO_AUTH`). Clawback still works afterwards.
- If a banned holder deletes and re-creates its MPToken entry, the new entry is **unauthorized** again. So the ban holds on-ledger, as long as nobody re-approves the address. The `BanRegistry` makes `authorizeHolder` refuse banned addresses.
- `Clawback` with more than the balance takes the whole balance. `clawback()` refuses instead, so the audit trail always shows the exact amount clawed back.

## Transaction reliability

`TransactionSubmitter` signs locally (the seed never leaves the process) and processes one transaction at a time per account, so `Sequence` numbers can't collide. Checks such as "is the holder banned or frozen?" run **inside the queue slot, immediately before signing**. Every transaction carries `LastLedgerSequence`. A method only resolves once its transaction is validated with `tesSUCCESS`. Otherwise it throws one of:

- `TransactionNotAppliedError`: definitely not in the ledger. Safe to retry.
- `TransactionFailedError`: validated with a `tec` code. The fee is spent, nothing else changed.
- `TransactionOutcomeUnknownError`: **do not retry blindly**. Reconcile by `hash` first.
- `ComplianceError` subclasses: refused before signing.

All amounts are `bigint` base units (`toBaseUnits` / `fromBaseUnits` convert to and from decimal display amounts).

## Production checklist

- **Key custody**: run the issuer key in a KMS or HSM, or behind a signing service, not in a `.env` file. Consider multisig for the ban, clawback and global-freeze paths.
- **Single writer**: the queue only serializes within one process. Route every issuer transaction through one signing service.
- **BanRegistry**: replace `FileBanRegistry` with your compliance system of record (a durable database with an audit trail).
- **Audit sink**: the `audit` callback receives every attempt, including rejected and failed ones. Send it to append-only storage.
- **Mainnet**: switch `XRPL_URL`, review reserves and fees (`maxFeeDrops`), and decide the `AssetScale` before creating the issuance. The demo uses `assetScale: 0` so that 500 on the ledger means 500 tokens.

## Files

- `src/issuer.ts`: `MptIssuer`, the backend-facing API
- `src/submitter.ts`: reliable signing and submission queue
- `src/ledger.ts`: validated-ledger reads, flag constants
- `src/banRegistry.ts`: ban persistence interface and implementations
- `src/amounts.ts`, `src/errors.ts`
- `src/holder.ts`: holder-side operations (demo and tests only)
- `src/demo.ts`: testnet demo
- `test/`: offline unit tests against an in-memory ledger fake
