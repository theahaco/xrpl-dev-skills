# XRPL testnet MPT issuer

Strict TypeScript issuer module using `xrpl`. The demo uses the supplied issuer and funds three new holders with 10 test XRP each. Secrets are supplied through `ISSUER_SEED`; generated holder seeds and signed transaction journals stay under ignored, restricted `.private/`. Never commit that directory.

## Run

```sh
npm ci
npm run build
npm test
ISSUER_SEED='<testnet seed>' npm run demo
```

`result.json` contains the issuance ID and holder addresses. `verification.json` contains a single validated-ledger snapshot and transaction receipts, including expected failures. Re-running a completed demo verifies the existing issuance instead of creating another.

## Backend API

Import `Issuer`, `Submitter`, `Journal`, and `BanStore` from `src/issuer.ts` (or compiled `dist/src/issuer.js`). Connect an `xrpl.Client`, construct a `Submitter` with an issuer wallet and durable journal, then call `Issuer.create(submitter)` or attach to an existing issuance with `new Issuer(submitter, issuanceId, banStore)`. Call `verifyConfiguration()` before use.

- `approve(address)`: issuer authorization after your backend has completed KYC. The holder must first sign `MPTokenAuthorize` without `Holder` to opt in. The module does not perform KYC.
- `mint(address, integerString)`: issue tokens to an authorized, unfrozen holder.
- `clawback(address, integerString)`: remove tokens, including from frozen holders. XRPL caps recovery at the actual balance; a zero-balance clawback fails.
- `ban(address)`: persist deny intent, revoke ledger authorization, claw back remaining balance, verify zero and unauthorized. Safe to resume after reconciling an interrupted transaction. No unban API.
- `freezeHolder(address, true/false)`: lock/unlock an individual holding.
- `freezeAll(true/false)`: lock/unlock the issuance.

Amounts are integer strings, never floating point. AssetScale is zero for this demo, so `500` means 500 tokens. Capabilities include RequireAuth, CanLock, CanClawback, and CanTransfer; trading, escrow, and confidential balances are not enabled. Ordinary MPT clawback does not require the account-level trust-line clawback flag.

## Compliance boundaries

**Native MPT locks are not an absolute prohibition on all movement.** XRPL permits holder redemption directly to the issuer while locked; issuer clawback is also intentionally available. The module blocks minting during locks, but cannot prevent independently signed transactions that the protocol allows. If zero movement including redemption is mandatory, native MPT locking does not meet that requirement. Do not represent it as doing so.

Bans are a multi-transaction workflow, not an atomic ledger operation. Durable policy prevents this module from reapproving, minting to, or unfreezing a banned account. Revoking authorization blocks new receipts before clawback. A failed workflow must be resumed and must not be reported as complete. A holder recreating an opt-in entry does not regain issuer authorization. Anyone independently controlling the issuer signing keys can override policy; the XRPL has no immutable address ban list.

## Operations and recovery

This repository provides tested testnet functionality, not a production deployment certification. `Submitter` checks network ID 1 before signing, caps fees at 1,000 drops, serializes transactions, journals signed bytes before broadcast, and requires validated metadata with `tesSUCCESS`. Validated failures have a `TransactionFailure.receipt`; transport failures have an uncertain outcome and block subsequent submission on that instance.

Production backend integration must provide a transactional durable `Journal` and `BanStore`, an exclusive issuer lock shared across all workers, access control for compliance methods, and protected signing (adapt the Wallet boundary for a managed signer). Use one `Issuer`/`Submitter` per issuer under that lock. The local FileStore is a single-process demo adapter; it is not a distributed database. Startup must reject unresolved journal entries, as the demo does. Operations are serialized within one module instance; arbitrary external issuer transactions are outside that guarantee.

On interruption:

1. Keep the `.private` directory. Do not blindly rerun a mint or creation transaction.
2. For each prepared transaction without a validated receipt, query `tx` using its hash. A validated response determines the outcome. If still pending, resubmit only the exact saved blob, or wait. Never replace it with a newly sequenced transaction merely because an RPC timed out.
3. If not found, establish that the validated ledger is beyond its saved LastLedgerSequence and that the server has complete ledger history for the submission interval before treating it as expired.
4. Reconcile `.private/active-step`, the validated ledger, and `demo-state.json`; record the outcome in the journal before removing the step marker. An uncertain step deliberately stops the demo for operator review.
5. After reconciliation, resume an incomplete ban. An interrupted ban retains its durable deny intent.

The demo lock file uses exclusive creation; a stale lock after a process crash must only be removed after confirming no other demo is running. Demo step markers prevent replay across a crash between ledger validation and checkpointing. Testnet can reset, so these artifacts are evidence for the recorded ledger, not permanent availability guarantees.

## Protocol references

- [MPT concepts and lock/redemption exception](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
- [Authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback)
- [Locking](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset)
