# XRPL testnet MPT issuer

Strict TypeScript issuer module using `xrpl`. The demo creates one issuance from the supplied issuer, funds three new holders with 5 test XRP each, exercises compliance controls, and verifies all final balances and flags in **one validated ledger**. Amounts are integer strings; `AssetScale` is 0, so `"500"` means 500 tokens.

**Native MPT freeze is not an absolute movement stop.** A locked holder can still redeem directly to the issuer, including under a global lock. Clawback is also intentionally available. The demo explicitly tests redemption while individually frozen. A requirement forbidding even redemption cannot be fulfilled using these native MPT controls. See [MPT compliance controls](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls) and [MPToken flags](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken#mptoken-flags).

## Run

Requires Node.js 22 or newer. The transport is deliberately pinned to XRPL Testnet, checks network ID 1, and caps transaction fees at 0.01 XRP.

```sh
npm ci
npm run build
npm test
# Supply the task's issuer seed through your secret manager/environment:
export XRPL_ISSUER_SEED='<testnet issuer seed>'
npm run demo
npm run verify
```

The seed is not saved. New holder seeds are retained in `.private/holders.json` with mode 0600 so interrupted runs can resume. `.private` is ignored by Git and must be treated as sensitive. Do not delete it to retry a run. When `result.json` already exists, the demo only rechecks the final state. Testnet resets can invalidate previous results.

`result.json` has exactly the requested issuance ID and holder addresses. `verification.json` records the public ledger entries, ledger hash, and index used to verify the result. `audit.json` contains public transaction receipts. Expected failed payments consume testnet fees; `tecNO_AUTH` and `tecLOCKED` are assertions of enforcement, not demo failures.

## Backend use

```ts
import { Wallet } from 'xrpl';
import { TestnetLedger, FileBanStore, MptIssuer } from './src/index.js';

const transport = await TestnetLedger.open(
  Wallet.fromSeed(process.env.XRPL_ISSUER_SEED!), '/durable/issuer/journal',
);
try {
  const bans = new FileBanStore('/durable/issuer/bans.json');
  const token = new MptIssuer(issuerAddress, issuanceId, transport, bans);
  await token.validate();
  // The holder first signs MPTokenAuthorize with no Holder field.
  // Your backend must authenticate the operator and finish KYC before this call.
  await token.approve(holderAddress, 'kyc-case-123/approve');
  await token.mint(holderAddress, '500', 'payment-456');
  await token.freeze(holderAddress, 'incident-789/freeze');
  await token.unfreeze(holderAddress, 'incident-789/unfreeze');
  await token.clawback(holderAddress, '300', 'case-abc/clawback');
  await token.globalFreeze('incident-def/freeze');
  await token.globalUnfreeze('incident-def/unfreeze');
  await token.ban(holderAddress, 'case-ghi/ban');
} finally {
  await transport.close();
}
```

`MptIssuer.create` creates the compatible issuance; `MptIssuer` attaches to one. Issuance flags enable RequireAuth, CanLock, CanClawback, and CanTransfer (102). Trading, escrow, and confidential balances are disabled and rejected by validation. These other balance locations would require additional compliance handling. The module does not set the unrelated account-level trust-line clawback flag.

`clawback` accepts positive amounts up to 2^63−1. As specified by [XRPL Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback), an amount above the balance drains the balance; it does not fail for insufficient balance. Zero, decimals, signs, exponent notation, unsafe numeric input, and leading zeroes are rejected.

## Ban semantics and recovery

A ban is a multi-transaction operation, not atomic:

1. Persist the ban intent, preventing module approval, minting, and unfreezing.
2. Revoke on-ledger authorization. This stops further receipts independently of this module.
3. Claw back the entire remaining balance.
4. Read validated state and require zero balance and no authorization before returning success.

Revoking before draining closes the incoming-payment race. A concurrent redemption can only reduce the remaining balance. If any step fails, treat the ban as pending and retry the same key until verified. There is deliberately no unban API. A holder deleting and recreating their MPToken entry does not regain issuer authorization; the demo tests this. An address without an entry is already unable to receive and is still recorded as banned.

The ban store must survive restarts, restores, and migrations. XRPL has no irrevocable ban primitive: someone with the issuer signing key can reauthorize an address outside this module. Signing authority and the persistent policy store therefore belong inside the backend's access-control boundary. KYC decisions are supplied by your backend; this library does not perform identity verification.

Every transaction requires a unique business operation key. Retries with that key reuse the original signed transaction and receipt; reusing it for different parameters fails. The journal fsyncs the signed blob before broadcast, waits for validated metadata, saves even validated failures, and never blindly creates a replacement on timeout. On restart it reconciles unresolved hashes or resubmits the **same** signed blob. If a transaction has expired and its outcome cannot be established, the writer fails closed. Reconcile its hash, sequence, LastLedgerSequence and historical ledgers before taking any manual recovery action; do not delete the journal and blindly retry a payment.

The file adapter supports **one process and one shared MptIssuer instance per issuance**. Its exclusive directory lock prevents a second writer using the same journal directory. All users of an issuer account must share that writer; a different directory or external wallet can bypass this protection. A crash leaves a stale `writer.lock`; confirm the old process is dead before removing that empty directory. The lock is never automatically stolen. Protect and back up the entire state directory. Missing files in a lost state directory cannot be distinguished from a fresh installation.

For a distributed backend, implement `LedgerPort` and `BanStore` with a transactional database, shared account sequencing, durable idempotency and an HSM/multisig signer; keep policy checks and writes under the same distributed lock. This testnet implementation has not had an independent security audit and is not a claim of regulatory certification. Operator authorization, KYC evidence retention, key custody, monitoring of pending bans, and disaster recovery remain application responsibilities.

## Verification coverage

Unit tests cover amount boundaries, transaction fields, policy rejection, ban ordering, interrupted-ban recovery, and concurrent approval/ban ordering. The live demo tests unapproved receipts, individual send/receive locks, unfreezing with successful transfers, partial clawback, global locking and unlocking, ban drainage, issuer and peer payments to a banned holder, local reapproval rejection, and holder deletion/recreation. Final verification requires A=500 authorized/unlocked, B=700 authorized/locked, C=0 unauthorized, outstanding supply=1200, and global lock cleared.
