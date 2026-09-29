# Regulated MPT issuer (XRPL testnet)

Strict TypeScript issuer module using xrpl 5.3.0. Research and actual amendment snapshots are in [RESEARCH.md](RESEARCH.md) and `research/`.

**Compliance limitation:** native MPT locks block holder-to-holder transfers, but the live testnet also permits payments involving the issuer in both directions. The module rejects new issuance while a holder or the issuance is frozen, but a separate issuer signer can bypass that application check. `freeze` and `globalFreeze` implement these native semantics. They do **not** guarantee the absolute “cannot send” / “all movement halted” requirements. Do not certify those stronger controls from this implementation. Account-level restrictions would require a separately reviewed design.

## Run

```sh
npm ci
npm run build
npm test
ISSUER_SEED='<testnet seed>' npm run demo
npm run verify
```

The issuer address is fixed for this demo. The seed is accepted only from the environment and is never saved. Generated holder seeds and the signed transaction journal are in `.private/` (mode 0600, gitignored). The demo is resumable with the same private state and operation IDs. It funds each holder with 10 test XRP from the issuer. It uses scale 0: `"500"` is 500 tokens, not 500 cents.

`result.json` is written only after all final-state assertions pass. `verification.json` contains ledger objects from one validated ledger; `transactions.json` contains operation IDs, hashes, results, and ledger indexes. These are public evidence and contain no seeds. `npm run verify` independently rechecks final state without signing.

## Backend API

Use `FileStore.open`, a connected `Client`, `TransactionRunner`, and a `Signer` (address plus async signing function). `walletSigner` adapts an xrpl Wallet; a backend can supply an external signing service. `MptIssuer.create(runner, signer, operationId)` creates the configured issuance. Reattach using `new MptIssuer(runner, signer, issuanceId)` and `assertConfiguration()`.

| Method | Effect |
| --- | --- |
| `approve(operationId, holder)` | Grant ledger authorization after your backend's KYC decision |
| `issue(operationId, holder, integerString)` | Send exact token quantity |
| `clawback(operationId, holder, integerString)` | Remove up to the requested quantity; protocol clamps to current balance |
| `freeze(operationId, holder, boolean)` | Set/clear native holder lock |
| `globalFreeze(operationId, boolean)` | Set/clear native issuance lock |
| `ban(operationId, holder, reason)` | Persist ban, lock, revoke authorization, claw back balance, verify zero/unauthorized |
| `holder(address, ledger?)`, `issuance(ledger?)` | Read validated state |

Holders must sign their own `MPTokenAuthorize` opt-in before approval. The demo uses fixture KYC approvals; this module does not perform identity verification. Authenticate and authorize backend callers before exposing these methods.

## Operational contract and recovery

Every logical operation needs a stable unique ID. Never generate a new ID merely because a request timed out. Amounts are canonical positive integer strings up to 2^63−1; no floating point is used. Clawback burns supply rather than crediting a spendable issuer balance.

The module serializes its methods. Share one runner for every operation involving the issuer, and route all issuer signing through it. FileStore takes an exclusive process lock for its entire lifetime. Multiple processes must use a transactional database implementation of `Store` plus an issuer-wide distributed lock; this filesystem adapter is for a single service writer. Do not run another wallet/service against the issuer concurrently.

Transactions are autofilled, bounded to 0.01 XRP fees, locally signed, and durably recorded **before** broadcast. Successful completion requires a validated `tesSUCCESS`. Validated failures are retained and raised as `LedgerFailure`. A repeated ID returns the original outcome and rejects different input. After an uncertain submission, the runner halts new work; restart and resume the original ID to query its hash and, if needed, resubmit the identical blob. Expired unresolved transactions require full-history reconciliation; the code deliberately does not create a replacement that could duplicate value movement. Missing history is not proof of failure.

Bans are a multi-transaction workflow, not atomic. Intent is persisted before ledger changes, and an interrupted ban remains locally banned. Retry `ban` with the same operation ID until final zero-balance/unauthorized verification succeeds. No rollback reapproves the holder. Ban records have no automatic expiry or unban API. Retain and back up the compliance store; losing it loses the local protection against future reapproval. A signer with direct issuer-key access can bypass any backend policy, so access control remains essential.

After a process crash, `.private/compliance.json.lock` may remain. Confirm the original process is dead before removing the stale lock. Never remove a lock held by a live process. Retain holder seeds and the journal when recovering the demo; do not delete state and rerun against the same issuance.

Final verification is a point-in-time assertion, not perpetual monitoring. Testnet can reset. This implementation and its integration evidence are a starting point for security review, custody integration, monitoring, and a production deployment review; the demo is not regulatory certification.
