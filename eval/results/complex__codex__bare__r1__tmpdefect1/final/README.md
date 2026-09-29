# XRPL MPT compliance issuer

Strict TypeScript issuer module using pinned `xrpl@5.3.0`, targeting XRPL testnet only. The demo uses issuer `rwtSKPNxCCKaLRpTgpYnWgZ8t2DBw8vXgo` and funds three newly generated holders with 10 test XRP each. No issuer seed is stored in source or output artifacts.

## Important protocol boundary

**MPT locks do not satisfy an absolute “cannot send” or “freeze all movement” requirement.** A locked holder can still redeem directly to the issuer. The same redemption exception applies during global locking. The demo explicitly exercises these exceptions, records successful redemption transactions, and restores A to 500 afterward. The module blocks its own mint operation while the holder or issuance is locked. It cannot prevent a holder from submitting a redemption directly to XRPL. Clawback also remains an administrative movement mechanism.

The native ledger controls are implemented and tested; an absolute halt to all movement is not achievable with these MPT controls. Compliance must account for this boundary before relying on the system for that policy. This is a testnet implementation, not a certification of regulatory suitability or an audited mainnet deployment.

## Run

Use Node.js 22.13+ (tested with 25.9), which provides `node:sqlite`.

```sh
npm ci
npm run build
npm test
# Supply the testnet issuer seed through your secret manager or shell environment.
ISSUER_SEED='<testnet seed>' npm run demo
npm run verify
```

`verify` needs no seed and performs no ledger mutations. It checks the issuance and all holdings at one validated ledger index. The demo persists checkpoints and transaction intents in `.private/demo.sqlite`; rerunning with this store resumes the same issuance and holders. Do not delete the store to resume a run.

Outputs:

- `result.json`: exactly the issuance ID and A/B/C classic addresses requested.
- `verification.json`: validated ledger index/hash, issuance fields, balances and flags.
- `demo-evidence.json`: validated transaction hashes, result codes and metadata, including expected rejected payments. Failed ledger transactions still incur a small fee.
- `.private/demo.sqlite`: private holder seeds, signed transaction journal, compliance ban records and demo checkpoints. Excluded from version control. Protect and back up this directory; it is not encrypted at rest.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { Store, Transactions, MptIssuer, walletSigner } from './src/index.js';

const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const store = new Store('/secure/issuer/state.sqlite');
const transactions = new Transactions(client, store);
const signer = walletSigner(Wallet.fromSeed(process.env.ISSUER_SEED!));
try {
  const issuer = await MptIssuer.open(transactions, signer, issuanceId);
  await issuer.approve(kycApprovedAddress, 'kyc-case-123:approve');
  await issuer.mint(kycApprovedAddress, '500', 'distribution-456');
  await issuer.clawback(kycApprovedAddress, '300', 'case-789:clawback');
  await issuer.freezeHolder(kycApprovedAddress, true, 'case-790:freeze');
  await issuer.freezeHolder(kycApprovedAddress, false, 'case-791:unfreeze');
  await issuer.freezeAll(true, 'incident-100:freeze');
  await issuer.freezeAll(false, 'incident-100:unfreeze');
  await issuer.ban(kycApprovedAddress);
} finally {
  store.close();
  await client.disconnect();
}
```

`MptIssuer.create(transactions, signer, operationId, maximumAmount?, assetScale?)` creates a new issuance. The default maximum is 1,000,000,000 base units and scale is zero. All amounts are canonical positive integer **strings in base units**, validated using `bigint`. With scale 2, 500 tokens would be passed as `"50000"`. Clawback takes up to the requested amount, capped by the actual holder balance; it cannot recover tokens the address no longer holds.

The signer interface is asynchronous, allowing a backend to integrate a protected signer instead of a seed-bearing wallet. The holder must independently submit `MPTokenAuthorize` without `Holder` to opt in before approval/distribution. The issuer never needs a holder seed for compliance operations; only the demo holds those seeds to exercise holder transactions. KYC, service authentication, operator authorization and case approval are the backend's responsibility.

## Compliance semantics

| Control | Implementation | Guarantee |
| --- | --- | --- |
| Allowlist | RequireAuth at creation; issuer `MPTokenAuthorize` | Holder opt-in alone does not grant permission to receive |
| Clawback | CanClawback at creation; MPT `Clawback` with `Holder` | Burns up to the requested available balance, including locked holdings |
| Holder freeze | CanLock; `MPTokenIssuanceSet` with Holder | Blocks holder-to-holder sending and receiving; redemption exception above |
| Global freeze | `MPTokenIssuanceSet` without Holder | Blocks secondary transfers across the issuance; redemption exception above |
| Ban | Durable ban intent, revoke authorization, lock, drain, verify zero | Address cannot receive without a new issuer authorization, which this module refuses |

CanTransfer is enabled so freeze demonstrations exercise actual transferable tokens. Trading, escrow, confidential balances and permissioned-domain authorization are not enabled; opening an issuance with these features is rejected. This avoids alternate authorization and balance paths outside this module's accounting. MPT capabilities belong to the issuance; no trust-line AccountSet clawback flags are needed.

A ban is a **multi-transaction operation**, not atomic. The durable ban intent immediately blocks subsequent module approval/mint/unlock requests. Authorization is revoked on ledger before draining so incoming transfers cannot refill the holder afterward. The amount can change before revocation validates; no off-ledger call can freeze the ledger retroactively. Successful completion requires zero balance and no authorization. Interruptions must be retried with `ban(holder)` until complete; the record remains pending and restrictive after a failure. A redemption racing the drain is accepted only when the final verified balance is zero.

The demo additionally has C delete and recreate its empty holding. This removes C's old lock flag but **does not restore authorization**; both a holder payment and issuer payment to C are then rejected. Thus C finishes with balance zero, authorization false and lock false. Its persistent ban remains in the compliance store. A lock alone would not be a durable address ban. An issuer-key operator bypassing this module could reauthorize C: XRPL has no irrevocable address-ban primitive. All authorized issuer services must share and respect the ban database.

## Transactions, concurrency and recovery

Every operation requires a stable, unique business operation ID. A reused ID with a different transaction intent is rejected. Successfully completed IDs replay their receipt without resubmitting. Freeze/unfreeze cycles need distinct IDs. Ban uses deterministic internal step IDs.

Transactions are serialized, autofilled with ledger expiry, locally signed, journaled **before** transmission, and accepted only with validated `tesSUCCESS`. Fee is capped at 1,000 drops. Network ID must be 1. A validated failure is saved and raised as `LedgerFailure`, including its hash and code. It is never silently treated as success. No fresh payment is automatically signed after a timeout.

Unknown outcomes block further new submissions. Retry the original operation ID to query its hash and, when needed, retransmit the exact saved signed blob. A missing transaction, timeout, unvalidated response or transport failure is not proof of failure. If a transaction expires without a known validated outcome, the service intentionally stays blocked: an operator must reconcile its hash and LastLedgerSequence against a server with complete relevant ledger history before resolving the record. Do not clear `unresolved` merely because a single `tx` request returned `txnNotFound`. No automatic expired-transaction replacement is implemented.

Use one `Transactions` instance for the issuer account and one store for all issuance instances in that service. Multi-step issuer operations share a queue. The store uses SQLite WAL with FULL synchronization and an exclusive process lock; it rejects a second writer. This is a **single-service** persistence implementation, not a distributed lock manager. Multiple independent stores or external issuer submissions would defeat its sequencing and compliance coordination. For a distributed backend, integrate a shared transactional database, per-account serialization and a durable recovery worker before deploying.

After a process crash, confirm the former process has stopped before removing the stale `<database>.lock` file. Keep the database and WAL files intact. Restart with the same store and resume the original operation. Backups, pending-operation alerts, ban recovery, key custody and independent review remain deployment work. Never expose `Transactions.submit`, the signer, or direct database writes to untrusted callers.

## Verification coverage

Unit tests exercise amount precision, concurrent idempotent retries, operation-ID conflicts, unknown outcomes, validated failure persistence, network guards, unvalidated responses, persistent storage, exclusive ownership, and interrupted ban recovery. The live demo tests allowlist rejection, holder send/receive lock rejection, successful transfers after unlocking, global lock rejection, actual redemption exceptions, partial clawback, ban drain and re-creation of a banned holding.

Protocol references: [MPT authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize), [MPT locking](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset), [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback), [MPT standard, including redemption exception](https://xls.xrpl.org/xls/XLS-0033-multi-purpose-tokens.html), [MPT payment errors](https://xrpl.org/docs/tutorials/payments/send-an-mpt).
