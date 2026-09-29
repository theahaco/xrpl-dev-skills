# Regulated MPT issuer — XRPL testnet

Reusable strict TypeScript issuer service, a resumable testnet demo, and read-only ledger verification.

**Compliance limitation:** the requested absolute per-holder/global “no movement” freeze is not available with native MPT locks. Locked holders can still return tokens to the issuer; the issuer can still send tokens to locked holders; clawback remains possible. The demo exercises these issuer-interaction exceptions, including global locks, on testnet. `issue()` refuses locked recipients/global locks locally, but this is not a ledger guarantee. Do not represent these controls to compliance as an absolute freeze or deploy this design under that requirement. No application check can prevent a holder or another issuer-key user from submitting directly to XRPL. See [MPToken flags](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken) and the live transaction evidence in `demo-audit.json`.

The demo uses the supplied issuer address and three newly generated holders. `result.json` is written only after the final state passes assertions at one validated ledger. `verification.json` includes that ledger's hash, raw issuance and holding entries. `demo-audit.json` contains transaction hashes, outcomes and metadata, without seeds or signed transaction blobs.

```sh
npm ci
npm run build
npm test
# Supply ISSUER_SEED through your secret manager/environment.
npm run demo
npm run verify
```

Node 25.9.0 or newer is required for this implementation's built-in SQLite API. The existing environment has Node 25.9.0. Installed direct dependencies are pinned in package.json and package-lock.json. Research and live amendment snapshots are in [docs/research.md](docs/research.md).

## Backend use

```ts
import { Client, Wallet } from 'xrpl';
import { Store, TransactionRunner, MptIssuer, TESTNET } from './src/index.js';

const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
await client.connect();
const store = new Store('.state/backend.sqlite');
const signer = Wallet.fromSeed(process.env.ISSUER_SEED!);
const runner = new TransactionRunner(client, store);
try {
  // Save the returned ID. Use open(id, signer, runner, store) thereafter.
  const token = await MptIssuer.create(signer, runner, store, 'issuance-request-123');
  // Holder signs MPTokenAuthorize without Holder before issuer approval.
  // Pass a reference to a REAL completed KYC decision; demo KYC is simulated.
  await token.approve(holderAddress, {
    reference: 'kyc-case-456', approvedBy: 'compliance-reviewer-789',
  }, 'approval-request-456');
  await token.issue(holderAddress, '500', 'mint-request-123');
  await token.freezeHolder(holderAddress, true, 'freeze-request-123');
  await token.freezeHolder(holderAddress, false, 'unfreeze-request-123');
  await token.clawback(holderAddress, '300', 'claw-request-123');
  await token.freezeGlobal(true, 'incident-start-123');
  await token.freezeGlobal(false, 'incident-end-123');
  await token.ban(holderAddress, 'sanctions-case-123', 'ban-request-123');
} finally {
  await client.disconnect();
  store.close();
}
```

Replace `holderAddress` with an opted-in holder. A `Signer` may be implemented with an HSM/custodial signer; it need not expose a seed. Restrict access to all signing and issuer operations to authenticated, authorized backend callers. This library does not perform KYC or implement your organization's approval workflow.

## Control semantics

| Control | Implementation | Guarantee and limits |
| --- | --- | --- |
| Allowlist | `tfMPTRequireAuth` at creation; issuer `MPTokenAuthorize` | Holder opt-in alone is insufficient. Only issuer-approved holders receive tokens. No permissioned-domain alternative authorization. |
| Clawback | `tfMPTCanClawback`; `Clawback` with `Holder` and MPT amount | Positive integer amount, up to available balance. XRPL caps a larger request to the current balance. This burns tokens; it does not credit another holder. |
| Ban | Durable local tombstone, validated revoke, full-balance clawback, validated postcondition | Prevents approval/unfreeze/mint via service; ledger revocation prevents receipts. Zero-balance deletion/recreation does not restore authorization. |
| Holder freeze | `MPTokenIssuanceSet` lock/unlock with `Holder` | Native MPT lock; issuer-interaction exceptions described above. |
| Global freeze | Same transaction without `Holder` | Locks issuance; does not erase individual locks when lifted. Issuer-interaction exceptions still apply. |

Capabilities are enabled at creation: flags `102` (`0x66`), scale `0`, maximum outstanding amount `1,000,000,000`, transfer fee `0`. Amount strings are whole ledger units, so `500` means 500 tokens. Escrow, DEX trading, confidential transfers and permissioned domains are excluded from this profile. Do not enable them outside this service: ban/drain assumptions would require review. No IOU account flags or trust lines are used.

A ban is a sequence of ledger transactions, not atomic. Its durable tombstone immediately prevents this service from approving the address; ledger enforcement starts when revocation validates. Tokens can move before revocation validates. `ban()` reports completion only after observing zero balance and no authorization. It can be resumed using the same operation ID. There is deliberately no unban API. An issuer key used outside this service can still reauthorize an address; protect the key and retain the policy database.

## Submission, concurrency and recovery

Keep **one Store and one TransactionRunner per issuer service**, and route all issuer signing through it. Issuer controls share a queue, even across multiple MptIssuer objects using that runner. SQLite and an exclusive lock file prevent two processes opening the same store. This is a single-writer backend component; distributed deployments need a shared durable queue/lease and database adapter before use.

Every operation needs a globally unique, stable business request ID. Retry the same request with the same ID and payload. Different payloads under a reused ID are rejected. Never use a new ID merely because a request timed out. Signed transactions are committed to SQLite before submission; validated results and clearing of pending state are committed together. Fees are capped at 0.01 XRP; autofill supplies sequence and LastLedgerSequence. Validated `tec` failures are durable failures and must not be retried under a new ID without a new business decision.

`submitAndWait` handles queued transactions using the same signed bytes. After an interrupted submission or `tefPAST_SEQ`, the runner queries the original transaction hash. If it cannot prove a validated outcome, it raises `UnresolvedTransaction` and blocks new transactions for that account. Retry the original ID to reconcile. There is intentionally no blind sequence refresh or automatic reminting. For an expired, unvalidated transaction, an operator must establish non-inclusion over the entire submission ledger range using a server with complete history before deciding on a replacement. Do not delete the journal to bypass this check.

The demo checkpoints each step and encrypts holder seeds with AES-256-GCM using a salted scrypt-derived key from the supplied test issuer seed. The issuer seed is never stored. Keep `.state/` private and backed up; losing it loses holder keys, request deduplication and ban policy. The local encrypted wallet scheme is for this testnet demo, not production custody. For a stale `.state/issuer.sqlite.lock` after a crash, first confirm no process owns the database and then remove only that lock file. Retain the database and its WAL; rerun with the same issuer seed. A completed rerun verifies the existing issuance and does not create another token.

## Validation and risk notes

Unit tests exercise integer boundaries, SDK serialization, duplicate IDs, ambiguous submissions, durable failures, incomplete-ban recovery, zero-balance default fields, and exclusive writer access. The live demo tests unapproved receipts, both directions of a holder lock, global lock, unlock transfers, partial clawback, banning, direct issuer and peer receipts to a banned account, deletion/recreation, and issuer-interaction exceptions. B first receives 1,000 and has 300 clawed back; a later one-unit issuer-payment probe is clawed back while B remains locked. The global issuer-payment probe is also reversed. Final verification reads A=500 authorized/unlocked, B=700 authorized/locked, C=0 unauthorized, and issuance globally unlocked with supply=1200.

The code is designed for review and backend integration, but has not undergone an independent security audit and does not satisfy the absolute-freeze requirement. Production rollout also requires appropriate custody, approval controls, monitored recovery, durable backups and a compliance decision on the native lock semantics. Testnet can reset; saved ledger evidence is point-in-time evidence. All signing in this run is local and limited to the explicitly configured public testnet.
