# XRPL MPT compliance issuer

Strict TypeScript backend module using `xrpl`, restricted to XRPL Testnet (`network_id=1`). This is a test token, not a backed stablecoin. All amounts are canonical integer strings in base units; this issuance uses `AssetScale=0` so `"500"` is 500 tokens. Maximum outstanding supply is 1,000,000,000.

## Run

Requires Node.js 22 or later.

```sh
npm ci
npm run build
npm test
# Set ISSUER_SEED through your secret manager/environment; never commit it.
npm run demo
npm run verify
```

The demo requires the supplied issuer address and its seed in `ISSUER_SEED`. `verify` is read-only and does not require a seed. The endpoint is fixed to testnet. The demo funds three new holders with 3 test XRP each from the issuer, checks live reserve requirements, and retains their seeds in `.private/holders.json` (mode 0600, ignored by git). The issuer seed is never written to a file. Each issuance/holding consumes an owner reserve; XRP fees also apply to validated failed transactions.

`result.json` contains only the issuance ID and holder addresses. `verification.json` records all final entries from one validated ledger. `audit.json` contains validated transaction hashes, result codes, ledger indices, and metadata, including expected rejection transactions. `.private/journal.json` contains the full signed transaction recovery journal and permanent ban policy. Preserve this directory when restarting the demo; removing it creates a new demonstration and loses local ban policy. The demo uses a process lock and checkpoints completed steps.

## Compliance semantics

- **Allowlist:** `tfMPTRequireAuth` on creation. Holders opt in using holder-signed `MPTokenAuthorize`; the issuer separately approves them after your backend verifies KYC. Holder self-authorization does not grant issuer approval.
- **Clawback:** `tfMPTCanClawback`; uses `Clawback` with `Holder` and an MPT amount. Positive requests above a holder's balance remove the entire available balance. Zero, fractional, negative, and overflow amounts are rejected locally.
- **Ban:** first durably records a permanent ban, then locks the holder, revokes issuer authorization, and sweeps the balance. It verifies zero balance and no authorization before returning. This is a multi-transaction workflow, not atomic: a failure must be retried with the same operation ID. Authorization revocation persists even if the holder deletes and recreates their empty holding. The durable ban record prevents `approve`, `mint`, and unfreeze via this module. There is no native permanent-ban ledger flag: someone independently using the issuer keys can reauthorize an account. Protect all access to those keys.
- **Individual freeze:** `MPTokenIssuanceSet` with `Holder` and lock/unlock flags.
- **Global freeze:** the same transaction without `Holder`. This is per issuance, not an issuer AccountSet flag.
- **Protocol limitation:** MPT locks block holder-to-holder movement, but issuer-involved payments are exceptions: holders can return tokens directly to the issuer (burn/redemption), and the live testnet demo also confirmed issuer minting during global lock. The module checks lock state before minting and refuses it under either individual or global freeze; direct use of issuer keys bypasses this application policy. The preflight check is not atomic with external issuer transactions, so all issuer operations must use the same worker. Clawback also remains available. Native MPT locks cannot provide the literal “no movement whatsoever” requirement. Do not represent this as an absolute stop on redemptions to your compliance team.

The issuance enables lock, authorization, transfers, and clawback (`Flags=102`). Trading, escrow, and confidential balances are disabled, keeping all balances available to ordinary clawback. Do not enable additional capabilities outside this module. Capability/issuer checks reject unexpected settings before compliance mutations.

## Backend usage

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer, TransactionExecutor, TESTNET, walletSigner } from './dist/issuer.js';
import { FileStore } from './dist/store.js';

const client = new Client(TESTNET);
await client.connect();
try {
  const store = await FileStore.load('/durable/private/compliance.json');
  const signer = walletSigner(Wallet.fromSeed(process.env.ISSUER_SEED!));
  const executor = new TransactionExecutor(client, store);
  const token = new MptIssuer(executor, signer, issuanceId);
  await token.assertCapabilities();
  // Only call after the backend has checked KYC and operator permissions.
  await token.approve(holderAddress, 'kyc-approval-123');
  await token.mint(holderAddress, '500', 'funding-request-456');
  await token.setFrozen(holderAddress, true, 'freeze-case-789');
  await token.clawback(holderAddress, '300', 'recovery-case-790');
  await token.setGlobalFrozen(true, 'incident-791');
  await token.setGlobalFrozen(false, 'incident-791-resolved');
  await token.ban(holderAddress, 'ban-case-792');
} finally {
  await client.disconnect();
}
```

Use one `MptIssuer` per issuance and one transaction executor per shared signing workflow. All operations for an issuer must go through a single serialized worker, including multi-step bans. The executor serializes sequence use in-process; the issuer serializes compliance workflows in-process. Creating multiple module instances does not provide a distributed lock. In a clustered backend, implement `ComplianceStore` with a transactional database and use a distributed single-writer queue/lease for the issuer. `FileStore` is the durable single-process adapter supplied for this demo, not a multi-process database. All issuer key access must be governed by the same compliance policy.

The `Signer` interface also supports an external signing service/HSM. It receives an autofilled transaction and must return a locally signed blob and hash. No secrets are sent to XRPL. Use backend authentication, role restrictions, approval policy, durable business operation IDs, backups and operational monitoring before serving real users. KYC decisions and case records belong in your backend, not public ledger metadata.

## Submission and recovery

Every state-changing call needs a stable, unique business operation ID. Repeating the same ID and identical transaction returns the original receipt; changing the transaction under that ID fails. New business actions (including a second freeze) need new IDs. Do not use a fresh ID to retry an uncertain payment or clawback.

Transactions are autofilled with a sequence, fee and `LastLedgerSequence`, signed locally, and durably journaled **before** submission. Fees above 1000 drops (0.001 XRP) are rejected. Only validated metadata with `tesSUCCESS` is accepted. A validated `tec` raises `LedgerFailure` and is never silently retried. Expected demo failures must match explicit ledger error codes.

The SDK's reliable submission waits for validation, including queued transactions. On submission errors (including past sequence), the executor looks up the original hash. If it cannot prove a validated outcome, `UncertainSubmission` exposes the operation ID and hash, preserves the pending record and blocks unrelated operations. Retry the same operation to resubmit the same signed blob, never to sign a second spend. If the last-ledger bound passes without a result, an operator must verify non-inclusion using a server with complete history covering the submission window before resolving the pending record. No automatic deletion or unsafe sequence retry is provided. Keep the journal and monitor unresolved operations; a permanently unresolved record intentionally stops the queue.

A ban that stops halfway leaves its policy record in force. Resume the same ban ID to finish the ledger changes. A process crash may leave `.private/demo.lock`; confirm no demo is running and reconcile pending records before removing that stale file.

## Validation

Local tests cover integer boundaries, signed MPT serialization, durable bans, ban ordering and recovery, duplicate operation IDs, concurrent calls, validated failure codes, fee limits and uncertain submission handling. The live demo checks rejection before approval, both directions of individual freeze, restored transfers after unfreeze, global transfer rejection, module-level mint rejection, and the native issuer-mint exception (followed by a compensating clawback), clawback while frozen, banned receipt rejection, and final balances/flags at one validated ledger.

## Protocol references

- [MPT capabilities and freeze exceptions](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
- [Authorization and revocation](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
- [MPT lock controls](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset)
- [Clawback amount and Holder semantics](https://xrpl.org/docs/references/protocol/transactions/types/clawback)

## Risk notes

This implementation has been tested on testnet, not independently audited or approved for regulated production use. Native freeze exceptions, issuer-key authority, durable ban storage, single-writer operation ordering, and reconciliation after outages are material parts of the compliance design. A real-money deployment also needs your custody, reserve, redemption and legal controls; this module does not establish those.
