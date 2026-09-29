# Regulated MPT issuer (XRPL testnet)

Strict TypeScript backend module using `xrpl` 5.3.0. No UI or trust-line token APIs. `src/index.ts` exports the reusable module; `src/demo.ts` runs the integration scenario. `result.json` contains the actual issuance and holder addresses. `verification.json` contains validated ledger evidence and transaction receipts from the demo.

**Compliance limitation:** native MPT freeze blocks holder-to-holder transfers and receipt of tokens, but holders can still redeem directly to the issuer. Clawback also remains available. Neither individual nor global MPT lock guarantees literally zero movement. This implementation does not claim otherwise; the demo proves the redemption exceptions with real transactions. If your policy requires blocking redemption as well, this native MPT design alone does not satisfy that policy. Do not treat the testnet demonstration as production compliance approval.

## Run

Requires Node.js 20.19+ (Node 22 LTS recommended).

```sh
npm ci
npm run build
npm test
# Supply the testnet issuer seed through your secret manager/environment:
ISSUER_SEED='<testnet seed>' npm run demo
npm run verify
```

The seed is never written to source, logs, or state. The demo verifies the seed belongs to `rB3criap1CczhesHSP5oAT9XtrVZPUb9kV`, connects to the official testnet endpoint, and checks network ID 1. It funds three fresh holders with 3 XRP each from that issuer. Holder keys are deterministically derived from an HMAC of the issuer seed, a random persisted demo salt, and the holder name. This is for reproducible test fixtures only; use independently managed holder wallets in a deployed application.

The demo journal lives in `.state/` (gitignored, restrictive permissions). Preserve this directory: it contains idempotency records, the holder derivation salt, and the ban registry. Repeating the demo with the same state resumes the same issuance and original signed transactions. Do not delete state to retry an uncertain submission. The final JSON is written only after the complete scenario passes a common validated-ledger snapshot assertion. `npm run verify` is read-only on ledger and writes a fresh `snapshot.json` without replacing the demo receipts.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { FileState, TransactionRunner, MptIssuer, TESTNET } from './src/index.js';

const store = await FileState.open('/secure/issuer-state');
const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
await client.connect();
try {
  const runner = await TransactionRunner.testnet(client, store);
  const signer = Wallet.fromSeed(process.env.ISSUER_SEED!);
  const token = await MptIssuer.create(runner, signer, 'issuance/business-id', {
    maximumAmount: '1000000000', assetScale: 0,
  });
  // For an existing issuance:
  // const token = await MptIssuer.connect(runner, signer, existingIssuanceId);
  // A holder first opts in with MPTokenAuthorize signed by their own wallet.
  // After your backend completes KYC and records the approval:
  // await token.approve(holderAddress, 'kyc/case-123');
  // await token.mint(holderAddress, '500', 'issuance/payment-123');
  // await token.clawback(holderAddress, '300', 'clawback/case-124');
  // await token.freezeHolder(holderAddress, 'freeze/case-125');
  // await token.unfreezeHolder(holderAddress, 'unfreeze/case-126');
  // await token.freezeAll('incident/127');
  // await token.unfreezeAll('incident/127-resolved');
  // await token.ban(holderAddress, 'compliance case 128', 'ban/case-128');
} finally {
  await client.disconnect();
  await store.close();
}
```

`Signer` is an injectable local/HSM signing interface; it does not require the module to possess a seed. KYC decisions, operator permissions, case management and authentication belong in the calling backend. Never expose raw issuer signing or the raw runner to untrusted callers.

| API | On-ledger effect |
| --- | --- |
| `create` | RequireAuth + CanLock + CanClawback + CanTransfer, zero transfer fee |
| `approve` | Issuer-side `MPTokenAuthorize` for an opted-in holder |
| `mint` | Exact direct MPT payment, no partial payment flag; checks authorization, ban and freezes |
| `clawback` | `Clawback` with `Holder` and an MPT amount |
| `freezeHolder` / `unfreezeHolder` | `MPTokenIssuanceSet` lock/unlock with `Holder` |
| `freezeAll` / `unfreezeAll` | Same transaction without `Holder` |
| `ban` | Durable policy denial, authorization revocation, full clawback, final verification |
| `holder` / `issuance` | Validated-ledger reads; optional ledger hash for a consistent snapshot |

All amounts are **integer ledger-unit strings**, from 1 through `9223372036854775807`; JavaScript numbers and fractional strings are rejected. AssetScale is configurable display metadata. This demo uses scale 0, so balances are exactly 500 and 700 ledger units. Clawback requests above a holder's balance are capped by the protocol at that balance; they cannot seize tokens a holder no longer owns.

## Ban guarantees and recovery

The ban registry is persisted before ledger work. The issuer then revokes authorization, preventing peer transfers and new receipts, and claws back the full balance. Revocation also survives holder deletion/recreation of the holding because new holdings start unauthorized. The demo tests that attack, plus issuer-origin and peer-origin payments to the banned account, and attempted backend reapproval.

This is a multi-transaction workflow, not an atomic ledger transaction. A crash may leave a balance awaiting clawback; the method does not report success until the balance is zero and authorization is absent. Resume `ban` with its original operation ID. If redemption races the clawback, a validated `tecNO_LINE` is accepted only when the subsequent state verification confirms zero and unauthorized. Until revocation validates, pre-existing holder transactions can still execute; a ban cannot claw back tokens already transferred elsewhere.

No permanent on-ledger blacklist primitive exists here. On-ledger revocation prevents receipts; the persistent registry prevents this module from later approving or unlocking a banned holder. A separate holder opt-in cannot override issuer authorization. An issuer key used outside the module can still reauthorize an address. Protect the registry and every issuer signing path; there is intentionally no unban API.

## Submission and operational boundaries

- A unique business operation ID is required for every mutation. Reusing an ID with different transaction contents fails. Store it with the business request before calling the module. Historical receipts prove the earlier operation, not the current state; use validated reads for current compliance decisions.
- Signed blobs, hashes and expiry are durably journaled before broadcast. Success requires validated `tesSUCCESS`. Validated `tec` failures retain receipts and are raised as `LedgerFailure`; they consume fees.
- `xrpl.js` follows queued submissions to validation. Transport failure or `tefPAST_SEQ` triggers hash reconciliation. Retries use the **same** signed blob and sequence, never a freshly signed payment. An unresolved journal entry blocks new transactions. Expired/unvalidated transactions deliberately require operator reconciliation against complete ledger history before any new business attempt. There is no blind fee escalation or automatic re-signing.
- `LastLedgerSequence` comes from `autofill`; missing expiry is rejected. The module independently caps fees at 0.01 XRP, checks validated account funds against current network reserves, and budgets owner reserve for issuance/holder creation. It never uses historical fixed reserve constants.
- `FileState` provides a single-host exclusive lifetime lock, fsync and atomic rename. A process crash leaves `writer.lock`: first establish that no writer remains and reconcile outstanding hashes before removing the stale lock. Keep filesystem permissions and backups secure. Do not edit a live journal.
- Use one runner per issuer and retain exclusive ownership for the entire workflow. Its shared compliance queue serializes approval, mint, freeze and ban operations. For multiple backend hosts, implement `StateStore` with a durable database, distributed issuer lock and transactional idempotency, rather than sharing this local file store. Keep all external signing coordinated with the same sequence manager.
- Escrow, trading, confidential balances and permissioned-domain authorization are excluded. Attaching to an issuance with these policies enabled is rejected. Review future amendment/policy changes before enabling such capabilities elsewhere.

## Verification and sources

Unit tests cover integer precision, wire serialization, durable locking, operation replay, validated failure handling, ban ordering, reapproval prevention, and incomplete-ban persistence. The live demo tests positive transfers, denied transfers, partial clawback, both freeze types and restoration, redemption exceptions, full ban, and holder object recreation. Final checks read issuance and all holders at the same validated ledger hash and require total outstanding supply 1200.

Protocol references: [MPT overview and freeze exceptions](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize), [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset), [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback).

Risk notes: this is a testnet implementation with live integration evidence, not an independent security audit. Production use needs backend access controls, protected signing, durable shared storage where applicable, reconciliation operations, monitoring and a policy decision about the redemption exception. Testnet can reset; rerun validation before relying on old artifacts.
