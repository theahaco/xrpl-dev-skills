# Regulated MPT issuer (XRPL testnet)

Reusable strict TypeScript issuer module: `src/issuer.ts`. Live demo: `src/demo.ts`. Research and amendment snapshots: `research/`. Exact npm dependencies are pinned in the lockfile.

**Protocol limitation:** Live testnet permits both issuer-to-holder issuance and holder-to-issuer redemption during individual and global MPT locks. Peer transfers are blocked. The module adds validated-state checks to reject issuance into a frozen holder or globally frozen token, but raw issuer-signed transactions can bypass these backend checks. Clawback also remains possible. Consequently neither individual nor global freeze can guarantee the literal “no sends / no movement” requirement. The demo records these exceptions. If compliance requires an absolute halt including redemption, this MPT implementation does not meet that requirement; backend checks cannot stop a holder signing directly.

## Run

Requires Node >=24 (tested with existing Node 25.9.0).

```sh
npm ci
npm test
export XRPL_ISSUER_SEED='<testnet seed>'
npm run demo
npm run verify
```

The issuer must be `rsGdajs49wqpyofW5LVjWH9ZVJdmWJSEDm`. The demo transfers 10 test XRP to each new holder. Holder seeds and the durable transaction journal live in `.private/`, excluded from git and protected by restrictive file permissions. The issuer seed is read from the environment and never written to project files. Do not print or commit that environment variable or holder seeds.

`result.json` is emitted only after a validated ledger snapshot proves A=500 authorized/unlocked, B=700 authorized/locked, C=0 unauthorized, issuance unlocked, and outstanding supply=1200. `verification.json` preserves that snapshot; `demo-evidence.json` records hashes, validated ledger numbers, and negative test results. `npm run verify` independently repeats final checks without any seeds.

## Backend integration

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer, Ledger, Store, TESTNET, checkTestnet } from './src/issuer.js';

const client = new Client(TESTNET);
await client.connect();
await checkTestnet(client);
const store = new Store('/persistent/issuer/state.sqlite');
const ledger = new Ledger(client, store);
const signer = Wallet.fromSeed(process.env.XRPL_ISSUER_SEED!);
const issuer = await MptIssuer.attach(ledger, signer, savedIssuanceId);
// For a NEW issuance only: MptIssuer.create(ledger, signer, uniqueCreationKey)

// Holder first signs optIn(holderAddress, issuer.id) with its own key.
await issuer.approve(holderAddress, opaqueKycReference, approvalOperationId);
await issuer.issue(holderAddress, '500', issuanceOperationId);
await issuer.clawback(holderAddress, '300', clawbackOperationId);
await issuer.setHolderFreeze(holderAddress, true, freezeOperationId);
await issuer.setHolderFreeze(holderAddress, false, unfreezeOperationId);
await issuer.setGlobalFreeze(true, incidentStartOperationId);
await issuer.setGlobalFreeze(false, incidentEndOperationId);
await issuer.ban(holderAddress, 'internal case reference');

store.close();
await client.disconnect();
```

Example variable names represent your backend's inputs. The exported `Signer` interface also accepts an asynchronous signing service; an in-process seed wallet is only the demo adapter. Protect signing authority with your deployment's custody and access-control system. The module does not perform KYC: approval is your backend's compliance decision. The opaque KYC reference is placed in an on-ledger memo, so never put names, documents, or other private information there.

All amounts are positive base-unit **strings**; this issuance uses AssetScale=0, so `'500'` is exactly 500 tokens. Maximum is 2^63-1. No JavaScript floating-point arithmetic is used. Clawback above the holder's balance removes the available balance, not an impossible larger quantity. Configuration enables require-auth, clawback, holder/global lock, and peer transfers; escrow/trading/confidential balances are disabled.

## Bans and failure handling

`ban` first durably records a permanent policy tombstone, then locks the holder, revokes issuer authorization, claws back the available balance, and verifies zero balance plus absent authorization. It returns only after those conditions are observed in validated state. This is a multi-transaction workflow, **not atomic**: call it again after an interruption. Movement can occur before the first lock validates; redemption can still occur during a lock. The demo also proves that deleting/recreating the zero-balance holding does not restore authorization. It deliberately leaves C's recreated holding unlocked and unauthorized; the ban depends on authorization, not a disposable lock flag.

A ban refuses future module approval, issuance, and unlock calls. XRPL has no immutable denylist primitive: someone controlling the issuer's signing keys can override policy by issuing raw authorization transactions. Keep all authorization through the same policy store and signing authority. Do not lose the ban database or replace it with an empty one.

Each ordinary mutation requires a unique backend operation key. Persist the key with the business request and reuse it for retries. The journal stores the signed blob **before** submission; a retry queries the same hash and can submit the same blob without repeating the economic action. Key reuse with different transaction content fails. Only validated `tesSUCCESS` is accepted; validated failures retain their hash/code. Fee is capped at 0.001 XRP and transactions have a LastLedgerSequence.

Unknown outcomes fail closed and block further new transactions from that account. `UncertainTransaction` exposes the key and hash. Retry the same operation first, or call `ledger.reconcile(key)` to resolve an already-signed transaction after a policy change (such as a ban) prevents a normal retry. Reconciliation never signs a replacement. If the signed transaction has expired without a resolved receipt, an operator must reconcile its hash against a server with complete history through LastLedgerSequence before resolving the journal and authorizing a replacement. This implementation intentionally does not automatically re-sign expired transactions. Do not clear a pending journal row merely because a request timed out.

Use one `Ledger`/`Store` writer for this issuer, and use its queue for all signing. Do not run other processes/signers against the issuer account or separate copies of its database. A lock file rejects a second writer on the same store path; after a process crash, verify that the old writer is stopped before removing the stale `.lock` file. SQLite uses WAL and FULL synchronous durability. The deployment must back up the database with its WAL using SQLite-aware backup procedures. Horizontal scaling requires an external account-level coordinator; this local store is not a distributed lock.

A successful cached receipt describes an operation at its original validated ledger; it does not assert that mutable ledger state has stayed unchanged since then. Use the read methods or independent verification for current state. The demo is a persistent deployment, not a new issuance on every invocation; keep `.private/` intact. Testnet can reset, in which case reconcile and explicitly start a new deployment instead of treating old receipts as current proof.

## Validation

Unit tests cover exact amounts, capability configuration, durable bans, interrupted ban recovery, single-writer exclusion, operation-key conflicts, replay, unresolved outcomes, serialization, and issuer-side freeze checks. The testnet demo checks allowlist denial, working peer transfers, both transfer directions while individually frozen, backend issuance denial, global peer-transfer denial, native issuer-payment exceptions, partial clawback, ban, and recreation resistance. Final verification reads every balance/flag at the same validated ledger index.

This is a testnet implementation with documented protocol and operational limits, not a claim of regulatory certification or an absolute freeze capability.
