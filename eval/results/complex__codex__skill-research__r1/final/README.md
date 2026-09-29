# Regulated MPT issuer — XRPL testnet

Reusable strict TypeScript issuer module using xrpl 5.3.0, with an executable and resumable testnet demo. Research and exact source references are in [RESEARCH.md](RESEARCH.md).

**Compliance boundary:** XRPL MPT locks block holder-to-holder transfers, but allow payments in both directions between an authorized holder and the issuer. Global locking has the same exception. The module blocks minting to a locked holder or under a global lock, but another application using the issuer key can bypass this application policy. This implementation cannot fulfill an absolute “no sends / all movement stopped” policy using native MPT locks. The demo explicitly tests the exception. Do not represent these methods to compliance as an absolute freeze. Administrative clawback remains available while locked.

The requested balances and native lock flags are verified from a single validated ledger. `result.json` is written only after all assertions pass. Full transaction hashes, results and metadata are in `evidence/transactions.json`; final objects and ledger hash are in `evidence/final-state.json`.

## Run

```sh
npm ci
npm run build
npm test
# Supply the provided testnet issuer seed through your environment/secret manager:
npm run demo
# No seed needed for read-only verification:
npm run verify
```

The demo requires `ISSUER_SEED` and checks that it derives the specified issuer address. It funds three new accounts with 5 test XRP each. It uses integer units with AssetScale=0, a supply cap of 1,000,000,000, and no transfer fee. A final balance of 500 means exactly 500 tokens. The token has no real backing or redemption promise.

Re-running the demo with the same `.private` directory resumes completed steps; it does not intentionally create a second issuance or send duplicate funding. Holder seeds are encrypted with AES-256-GCM under a scrypt-derived key from the issuer seed. The issuer seed is never written to disk. Keep `.private/holders.enc.json` and the issuer seed if you need control of the holder accounts later.

## Backend interface

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer, preflight } from './src/issuer.js';
import { TransactionRunner } from './src/transactions.js';

const client = new Client('wss://s.altnet.rippletest.net:51233', { maxFeeXRP: '0.01' });
await client.connect();
await preflight(client);
const signer = Wallet.fromSeed(process.env.ISSUER_SEED!);
const runner = new TransactionRunner(client, '/durable/issuer-journal.json');
try {
  // To create: await MptIssuer.create(runner, signer, 'unique-create-request');
  const issuer = new MptIssuer(runner, signer, issuanceId);
  await issuer.assertConfiguration();
  await issuer.approve(holder, 'kyc-approval-request-id');
  await issuer.issue(holder, '500', 'mint-request-id');
  await issuer.freezeHolder(holder, true, 'holder-lock-request-id');
  await issuer.freezeHolder(holder, false, 'holder-unlock-request-id');
  await issuer.clawback(holder, '300', 'clawback-request-id');
  await issuer.freezeGlobal(true, 'incident-lock-request-id');
  await issuer.freezeGlobal(false, 'incident-unlock-request-id');
  await issuer.ban(holder, 'internal-case-reference', 'ban-request-id');
} finally {
  runner.close(); // after all outstanding method promises have settled
  await client.disconnect();
}
```

The caller performs KYC and authenticates/authorizes compliance operators. `approve` records ledger authorization; it does not perform KYC itself. Holders first sign their own `MPTokenAuthorize` opt-in, without a Holder field. Approval does not require custody of holder keys. `Signer` supports an asynchronous signing adapter for an HSM/custody service; only the demo uses local Wallet objects.

API amounts are canonical positive integer strings up to 2^63-1. Clawback follows protocol semantics: requesting more than a holder's balance takes all available tokens, not a negative balance. The module deliberately rejects issuances with incompatible flags, alternate authorization domains, fees or scales. Trading, escrow and confidential balances are disabled so no balance can escape into those mechanisms.

## Bans and recovery

`ban` is a sequence of transactions, not an atomic ledger operation:

1. Persist a permanent local deny decision before sending any transaction.
2. Revoke issuer authorization and await validation. A revocation by itself does not remove a nonzero balance.
3. Claw back all remaining units and await validation.
4. Read validated state and require zero balance and no authorization.

Once step 2 validates, no new receipts are allowed. Holder redemption can race step 3; the final zero-balance assertion decides completion. A holder could move tokens before revocation validates, as with any on-chain compliance action. The ban applies to this address, not its beneficial owner's other addresses. If a holder deletes and recreates its empty holding, the recreated object is unauthorized. The demo tests this bypass attempt on-chain. An issuer key holder can always reauthorize through another application; restrict issuer key access to your policy-enforcing service.

If interrupted, retry the same ban operation key. The deny policy persists and blocks approval, minting and unlocking through this module. Do not discard the journal or reconstruct bans from balances: an unauthorized account is not necessarily a banned account.

The runner persists the signed transaction and hash before submission, caps fees at 0.01 XRP, requires LastLedgerSequence, and accepts only validated metadata. `tec` failures have durable receipts and are never silently retried as new payments. `submitAndWait` handles queued transactions. Repeated requests first look up the original hash, so an already-validated transaction is recovered even if resubmission would encounter `tefPAST_SEQ`.

On a timeout or transport error, `UnresolvedTransaction` provides the hash; all new operations are blocked. Retry the same key and intent to reconcile/resubmit the same signed blob. **Never generate a new key merely because a request timed out.** If expiry or a permanent pre-ledger failure prevents automated reconciliation, an operator must establish the original transaction's outcome from a server with complete ledger history covering submission through LastLedgerSequence before retiring it. The implementation intentionally fails closed instead of guessing that a transaction was not applied.

## Deployment constraints and risk notes

- The file journal is a durable **single-writer, single-host** implementation. All writers for the account must share one runner/store. Its lock rejects another process opening the same journal. A crash leaves a lock; verify the recorded PID is no longer running before removing that lock and resuming. Do not use separate journals for the same issuer, share this over unreliable NFS, or expose the raw runner as a public API. For a multi-instance backend, replace this boundary with a transactional database/outbox and an account-wide distributed lock.
- Back up the journal and ban decisions on durable storage. Signed blobs contain no seed but remain submit-capable until expiry. Store access is restricted with owner-only permissions. Disk corruption or unavailable storage stops work; storage integrity is part of the deployment trust boundary.
- Runtime network checks require network_id=1. Keys are testnet-only. An endpoint check cannot cryptographically prevent replay of signatures on other networks with low network IDs; never reuse these keys on mainnet.
- Mainnet deployment, operator access control, KYC systems, HSM provisioning, independent security review and regulatory sign-off are outside this demo. The literal absolute-freeze requirement remains unsupported by native MPT locking.
- Testnet reserves/amendments are queried rather than assumed. Testnet resets can invalidate all saved IDs and receipts; archive the run and begin with a new store after a confirmed reset.

## Files

`src/issuer.ts` implements controls and ledger reads; `src/transactions.ts` implements signing/submission and idempotency; `src/storage.ts` implements durable file storage. `src/demo.ts` exercises controls and adversarial payments. `src/verify-state.ts` and `src/verify.ts` independently verify final state. `test/issuer.test.ts` tests offline safety properties. `evidence/` contains public audit records, with private state excluded from version control.
