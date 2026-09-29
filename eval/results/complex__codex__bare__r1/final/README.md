# Testnet MPT issuer

Strict TypeScript, pinned npm lockfile, `xrpl` SDK. `src/issuer.ts` exports `MptIssuer`, `TransactionRunner`, `PolicyStore`, and validated state readers. The issuer seed is supplied through `ISSUER_SEED`; it is never committed in source or audit logs.

```sh
npm ci
npm run build
npm test
ISSUER_SEED='<testnet seed>' npm run demo
```

The demo spends 30 test XRP funding three new holders. It uses scale 0: every amount is an integer token/base unit, never a JavaScript floating point number. All amounts are positive decimal strings bounded by 2^63−1. Clawback of more than the current balance removes the entire balance, as defined by XRPL.

The demo creates `.demo-secrets.json` with mode 0600, excluded from git. Preserve it to retain holder keys. It refuses to overwrite this file, so rerunning cannot silently create another token after partial completion. `demo-progress.json` identifies an in-progress issuance; `result.json` is published only after final assertions succeed. `audit.jsonl` records prepared signed transactions and validated outcomes, and `verification.json` contains a single-ledger final snapshot. No private seeds appear in those artifacts.

## Compliance semantics and limits

The issuance enables RequireAuth, CanLock, CanTransfer, and CanClawback. Trading, escrow, and confidential balances are not enabled. Holders first opt in with a holder-signed MPTokenAuthorize; the backend calls `approve` only after its own KYC decision. The module does not perform KYC itself.

`freezeHolder` / `unfreezeHolder` and `freezeGlobal` / `unfreezeGlobal` use MPT locking. **XRPL permits direct redemption back to the issuer while locked. These methods cannot guarantee absolutely no movement.** Clawback remains an issuer administrative operation. The module additionally refuses issuance payments while frozen. Do not present this as an absolute halt of all balance changes to compliance users.

`ban` first persists a permanent policy record, then revokes authorization, claws back any remaining balance, and verifies zero balance and no authorization. It is a resumable multi-transaction operation, not atomic: a holder may move funds before revocation validates. Revocation closes incoming transfers before the balance is read. A transfer racing with clawback can reduce the balance; rerunning ban reconciles the final state. A zero-balance holder may delete/recreate its holding object, but cannot restore issuer authorization. `approve`, `issue`, and `unfreezeHolder` reject banned addresses. There is no unban API. An issuer using its keys outside this module could authorize the holder again: the ledger has no immutable address ban flag.

## Backend integration

Create a connected `Client`, a secure signing wallet, a durable audit callback and a `PolicyStore`, then call `MptIssuer.create(runner, wallet, policy)` once. Persist the returned issuance ID. Subsequent processes use `MptIssuer.attach(runner, wallet, issuanceId, policy)`. Attach checks issuer ownership and required capabilities. Call `issue`, `approve`, `clawback`, `ban`, and the freeze methods with classic addresses.

A production deployment needs a transactional policy database, access control around KYC approvals and issuer actions, durable audit storage, protected signer custody, and a distributed single-writer lock covering all operations on this issuer. The in-process queues do not coordinate independent instances or external transactions. Keep the signer exclusive to this service; the testnet runner intentionally rejects other network IDs. The demo's append-only policy file is a single-process example, not a multi-worker database.

Every transaction is locally signed, fee-capped at 1000 drops, journaled before submission, and checked for validated `tesSUCCESS`. Successful submission alone is never treated as success. After a transport timeout, audit failure, or unknown result, stop the worker and reconcile the recorded hash with `tx` and its LastLedgerSequence. Resubmit only the same signed blob while valid; do not re-sign a payment or creation transaction blindly. An expired transaction is safe to replace only after proving it was not validated. Preserve the audit and investigate any prepared entry lacking an outcome. Retry incomplete bans after reconciliation. No automatic rollback unfreezes a holder or restores authorization.

The live demo checks rejection of unapproved receipt, frozen send and receipt, globally frozen transfer, banned receipt (including issuer payment), and banned receipt after holder-object recreation. It checks successful transfers after each unfreeze and verifies A=500/authorized/unlocked, B=700/authorized/locked, C=0/unauthorized, total outstanding=1200 and global lock cleared.

Protocol references: [MPT controls and redemption exception](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), [authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize), [locking](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset), [clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback).

This run encountered the server's omission of `MPTAmount` at zero after C's successful clawback. The reader now normalizes omitted balances to zero and the ban test covers that response. `src/resume-demo.ts` resumes only the final ban-verification portion using the existing progress and secret files; it does not repeat funding, minting, or B's clawback. It is not a general transaction recovery engine.
