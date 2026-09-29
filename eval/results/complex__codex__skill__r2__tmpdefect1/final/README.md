# Regulated MPT issuer — XRPL testnet

Strict TypeScript issuer library using pinned `xrpl` 5.3.0. The completed demo's addresses are in `result.json`; `demo-report.json` records validated transaction hashes, test results, and a final snapshot at one validated ledger hash.

**Compliance limitation:** native MPT locks allow a holder to redeem directly to the issuer, even while individually or globally locked. They block ordinary transfers in both directions. This implementation preserves those native semantics and demonstrates the redemption exception with `simulate` (no balance change). It cannot promise the literal requirement “no movement whatsoever.” Clawback is also deliberately available during a lock. See the [official MPT compliance controls](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls). Issuer-wide DepositAuth is a possible additional restriction, but would affect incoming payments for the entire issuer account and requires a separately designed redemption policy; it is not enabled here.

## Run

Requires Node.js 22+.

```sh
npm ci
npm run build
npm test
# Provide ISSUER_SEED through your environment/secret manager.
npm run demo
npm run verify       # Read-only; no seed required
npm run reconcile    # Read-only journal reconciliation report
```

The demo verifies the provided issuer address, funds three new holders with 5 test XRP each, creates one issuance, and checkpoints each step. It reuses its existing issuance on subsequent runs. It queries current reserves before funding. On this run, reserves were 1 XRP per account plus 0.2 XRP per owned object. Funding and transaction fees are paid from the supplied testnet account.

`result.json` is only written after every final invariant passes. A has 500, is authorized and unlocked; B has 700, is authorized and locked; C has zero and no authorization. The issuance is unlocked with total outstanding supply 1,200. The report contains the earlier freeze/unfreeze and clawback evidence.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { Executor, MptIssuer, TESTNET } from './src/issuer.js';
import { FileStore } from './src/storage.js';

const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
await client.connect();
const store = new FileStore('.runtime/backend-events.jsonl');
const executor = new Executor(client, Wallet.fromSeed(process.env.ISSUER_SEED!), store);
const token = await MptIssuer.open(executor, issuanceId, store);
// Or MptIssuer.create(executor, store) to create a new issuance.
await token.approve(holder);           // Backend confirms KYC before calling.
await token.mint(holder, '500');
await token.freeze(holder);
await token.unfreeze(holder);
await token.clawback(holder, '300');
await token.setGlobalFreeze(true);
await token.setGlobalFreeze(false);
await token.ban(holder);
await client.disconnect();
```

Before approval, holders must opt in with their own signed `MPTokenAuthorize` transaction. The backend never needs their keys. The demo alone generates holder keys to exercise holder transactions. Amounts are **integer strings in base units**, with AssetScale 0: `'500'` means exactly 500 tokens. Never pass JavaScript floating-point amounts. Clawback values above the current balance reclaim that entire balance; zero or an empty holding is not a valid clawback.

Issuance flags are `0x66`: CanLock, RequireAuth, CanTransfer, CanClawback. Escrow, trading and confidential balances are disabled to keep the asset within this control profile. These are MPT issuance flags, not trust-line/AccountSet clawback or freeze flags. No XRP account-level configuration is changed.

## Ban behavior

1. Commit permanent ban intent to the `BanStore`.
2. Revoke ledger authorization, blocking further receipts and ordinary transfers.
3. Claw back up to the maximum valid MPT amount, draining the current balance without trusting an earlier balance snapshot.
4. Verify validated balance zero and authorization absent.

The saga is not atomic. A holder can transact before revocation validates. Once ban intent is recorded, this module refuses approval, minting and unlocking for that address. A failure leaves the ban intent in place; retry `ban` after reconciling uncertain transactions. It is safe to repeat a completed ban. A holder can recreate a zero-balance MPToken object, but does not regain issuer authorization; the live demo tests this. Ban persistence is off-ledger policy plus ledger authorization revocation, not an irreversible protocol blacklist. Anyone with unrestricted issuer signing authority could override it. Protect the signing boundary and retain the ban database.

## Submission and recovery

The executor checks testnet network ID 1, autofills sequences/expiry, rejects fees above 0.01 XRP, signs locally, durably records the signed blob before submission, and checks validated transaction metadata. `LedgerFailure` includes the hash, ledger index and `tec` result; these transactions may consume fees. Unknown results produce `UncertainSubmission` and halt the executor. The persistent journal prevents a fresh process from silently submitting past an unresolved transaction.

The SDK waits for queued transactions. On a network failure, expiry or sequence conflict (`tefPAST_SEQ`), **do not create a new signed monetary transaction blindly**. Run `npm run reconcile`, query the recorded hash, and record a validated outcome using `FileStore.settled` when known. If still pending, only the same signed blob may be re-submitted. If absent, establish complete ledger-history coverage from submission through `LastLedgerSequence` and a validated ledger beyond expiry before concluding non-inclusion. A single `txnNotFound` response is insufficient. Only after reconciliation may the application decide whether a fresh operation is necessary.

Demo step starts without a completion marker fail closed. Review their journal records and ledger outcomes before appending a `step-reconciled` event to permit replay; append `step-done` instead if the intended effect already completed. Do not mark a monetary step replayable merely because the process exited. A stale `.runtime/demo.lock` also requires reconciliation before removal. The initial run encountered an omitted zero-balance field during preflight; the parsing fix and explicit no-submission reconciliation are retained in the local journal.

## Deployment boundary and risk notes

- `FileStore` is an fsync'd, append-only **single-process** reference adapter; the demo uses an exclusive process lock. A production backend must supply a durable database `BanStore`/`Journal`, application idempotency keys, an outbox, and a distributed lock covering all operations for the issuer account. Share one executor per signing account and one issuer instance per issuance within a process. Do not run independent writers against the file adapter.
- The `Signer` interface supports a remote signing implementation; the demo uses local `Wallet`. Restrict signing authority, enforce backend roles/KYC approval, and audit every compliance decision. No KYC provider, reserve attestation, fiat settlement or regulatory certification is implemented.
- `.runtime/` is ignored by Git and uses restricted permissions. Holder seeds are encrypted with AES-256-GCM using a scrypt-derived key from the issuer seed; no seed appears in source, result or report. Preserve this directory securely to recover the demo holders. The journal contains signed blobs, which are transaction submission capabilities until expiry. Protect backups and the issuer secret.
- State reads use validated ledgers. Final verification pins every read to the same ledger hash. Network reset or later authorized issuer actions can change testnet state.
- The module explicitly targets testnet. Mainnet deployment needs a separate reviewed configuration, signing integration, distributed coordination and an independent security review. Passing this demo is not a production security certification.

Protocol references: [MPT authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize), [MPT locking](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset), [clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback).
