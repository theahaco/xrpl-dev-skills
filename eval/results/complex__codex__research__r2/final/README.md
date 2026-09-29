# Regulated MPT issuer (XRPL testnet)

Strict TypeScript issuer module using `xrpl` **5.3.0**, TypeScript **7.0.2**, `tsx` **4.23.15**, and `@types/node` **26.6.3**. These were npm's latest stable releases when installed; exact versions and transitive dependencies are locked. Runtime used: Node **25.9.0**, npm **11.12.1** (preinstalled). Uses built-in `node:sqlite`; use Node 22.13+ or a newer supported Node release.

## Run

```sh
npm ci
npm run build
npm test
# Supply the issuer seed via your secret manager/environment. It is not in source control.
export XRPL_ISSUER_SEED='...'
npm run demo
npm run verify
```

The demo requires the supplied issuer address `rJ1UNnBGHY83XddoTMZstNKMvH6Esvi9Mx`. It creates three wallets, funds each with 10 test XRP from the issuer, and persists their seeds privately in `.private/demo.sqlite`. **Keep this database**: reruns resume the same issuance, accounts, and operations. `verify` is read-only and needs no seed. The demo writes `result.json` only after validating every required final balance and flag in a single ledger. `verification.json` records that snapshot; `audit.json` contains signed transaction hashes, intents and validated results, but no secrets or signed blobs.

## Compliance semantics

* The issuance has CanLock, RequireAuth, CanTransfer, and CanClawback (flags `102`). No trading, escrow, permissioned domain, transfer fee or confidential balances. AssetScale is **0**: all API amounts are positive integer strings in whole tokens, with no floating-point arithmetic. Maximum issuance is 1,000,000,000 units.
* Holders first opt in with their own `MPTokenAuthorize`. Your backend calls `approve` only after its KYC decision. Opt-in alone cannot grant authorization.
* `clawback` accepts any positive amount up to `2^63-1`. The ledger caps the actual clawback at the holder's available balance. Zero balance causes a ledger failure; clawback is also available while locked.
* `freezeHolder` and `freezeGlobal` set native MPT locks. The issuer API also refuses minting to locked holders or during a global lock.
* **Native MPT locks exempt returns to the issuer.** To close this exception, creation enables **DepositAuth on the dedicated issuer account**, with no deposit preauthorizations. This prevents holder-initiated redemptions even while unlocked. Redemptions must be managed by the issuer through clawback. This is an account-wide setting: unsolicited incoming payments in other assets are affected too (XRPL's emergency XRP funding exception still applies). Do not add deposit preauthorizations or disable DepositAuth. The module checks these invariants before operations, and the demo tests frozen redemptions directly on-ledger.
* `ban` persists a permanent local policy decision, locks the holder, revokes its ledger authorization, drains the balance, then verifies zero balance and no authorization. It is a **multi-transaction workflow**, not atomic. A failure leaves the policy ban active; retry the same operation ID to finish. Completion is reported only after verification. If the holder has no entry, RequireAuth already prevents receipt, and the durable policy blocks approval.
* A holder can potentially delete and recreate a zero-balance entry on the current testnet. Recreated entries are unauthorized. The demo attempts this attack and confirms receipt still fails. A lock alone is not a ban.
* There is no immutable protocol-level address blacklist. The issuer's signing authority could authorize an address again outside this module. Protect the signing key, restrict backend access, and preserve the ban database. The module refuses approval, issuance, and unfreezing of banned addresses, including after restart.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer, Store, Submitter, TESTNET } from './src/index.js';

const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
await client.connect();
const store = new Store('/secure/state/issuer.sqlite');
const submitter = new Submitter(client, store);
const wallet = Wallet.fromSeed(process.env.XRPL_ISSUER_SEED!);
// Once per issuance. Store the returned ID in your business database.
const issuer = await MptIssuer.create(submitter, wallet, 'issuance-business-id');
// Or attach: new MptIssuer(submitter, wallet, existingIssuanceId)
await issuer.approve(holderAddress, 'kyc-case-123:approve');
await issuer.issue(holderAddress, '500', 'mint-request-123');
await issuer.freezeHolder(holderAddress, true, 'incident-456:freeze');
await issuer.freezeHolder(holderAddress, false, 'incident-456:unfreeze');
await issuer.freezeGlobal(true, 'incident-789:global-freeze');
await issuer.freezeGlobal(false, 'incident-789:global-unfreeze');
await issuer.clawback(holderAddress, '300', 'recovery-123');
await issuer.ban(holderAddress, 'Compliance case reference', 'ban-case-123');
// Drain queued work before closing the store/client.
await client.disconnect();
store.close();
```

The snippet illustrates independent operations; execute only the operations your business workflow requires. Ban reasons should contain case references rather than personal KYC data.

## Transaction safety and operation

Use a stable, unique business operation ID for each action. Reusing an ID with different transaction fields is rejected. Signed blobs and hashes are committed to SQLite (WAL, synchronous FULL) **before submission**. Success requires a validated ledger result of `tesSUCCESS`; validated `tec` failures are persisted too. No retry automatically creates a fresh signature or sequence. A lost response is recovered by querying the original hash before resubmitting the same blob.

An unresolved transaction blocks new transactions. Resume the original operation with the same ID; if expired or the server lacks history, reconcile its hash against a trusted full-history server. Never blindly create a new ID for an uncertain payment or clawback. The implementation deliberately fails closed rather than assuming a timeout means failure. Preserve pending records and the audit trail when conducting manual reconciliation.

One `Store` owns an exclusive filesystem lock and one shared `Submitter` serializes issuer workflows. Use **one writer per issuer**, including external tools and other application replicas. Multiple stores cannot coordinate sequence allocation for the same issuer. After a process crash, confirm the old process is dead before removing only the stale `*.lock` directory; retain the database and WAL files. The demo closes the lock on ordinary exceptions. Backend methods serialize themselves; direct `Submitter.send` calls must be wrapped in `exclusive`.

Fees are capped at 0.01 XRP; transactions expire using the SDK's autofilled LastLedgerSequence. Network ID and required validated amendments are checked, and the module rejects mainnet. External changes by another issuer signer can invalidate guarantees; account settings and issuance flags must be monitored as part of deployment operations. KYC decisions, authentication, operator authorization, secret management, database backup, and business audit retention belong in the hosting backend. This is tested testnet software, not an independent security audit or regulatory certification.

## Evidence

See [research/README.md](research/README.md) for pre-implementation research and source links, [audit.json](audit.json) for successful and rejected ledger transactions, and [verification.json](verification.json) for final balances and settings. Unit tests cover integer bounds, ban persistence, exclusive execution, validated failures, idempotency, and recovery from a response lost after validation. The demo tests allowlisting, both directions of holder freeze, blocked redemptions, unfreezing, clawback, global freeze, and ban entry recreation.
