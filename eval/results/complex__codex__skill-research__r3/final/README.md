# Regulated MPT issuer (testnet)

Strict TypeScript backend module using xrpl 5.3.0. The demo issues from `rnS9o1Trk4KyspmMjGeWFBdpwhhGprFFh1`, funds three new holders with 5 test XRP each, exercises every control, and writes `result.json` only after verifying the final state in one validated ledger.

```sh
npm ci
npm run build
npm test
# Supply ISSUER_SEED through the environment or your secret manager.
npm run demo
npm run verify
```

Requires Node with `node:sqlite` support (tested on 25.9.0). Unit tests need no credentials or network. Verification is read-only and needs no seed. `RESEARCH.md` records the pre-implementation research and live amendment checks.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { Journal } from './src/journal.js';
import { Ledger, TESTNET } from './src/ledger.js';
import { MptIssuer } from './src/issuer.js';

const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
await client.connect();
const journal = new Journal('/durable/private/path/issuer.sqlite');
const ledger = new Ledger(client, journal);
const signer = Wallet.fromSeed(process.env.ISSUER_SEED!);
try {
  // Once only; persist its returned issuanceId in your application database.
  const token = await MptIssuer.create(ledger, signer, 'unique-create-request');
  // On later requests: new MptIssuer(ledger, signer, savedIssuanceId).
  // Holder signs MPTokenAuthorize to opt in before issuer approval.
  // await token.approve('approval-request-id', holderAddress, 'kyc-case-reference');
  // await token.mint('mint-request-id', holderAddress, '500');
  // await token.clawback('clawback-request-id', holderAddress, '300');
  // await token.freeze('freeze-request-id', holderAddress);
  // await token.freeze('unfreeze-request-id', holderAddress, false);
  // await token.globalFreeze('incident-freeze-id');
  // await token.globalFreeze('incident-resolve-id', false);
  // await token.ban('ban-request-id', holderAddress, 'compliance-case-reference');
} finally {
  await client.disconnect();
  journal.close();
}
```

Amounts are positive decimal **integer strings in base units**, bounded by 2^63−1. The demo uses AssetScale=0, so 500 means 500 tokens. Create supports a different scale; callers must convert display amounts exactly. Clawback follows ledger semantics: amounts above the balance recover the entire available balance, not an overdraft.

KYC decisions are supplied by your authenticated backend. This module does not perform KYC or authorize HTTP callers. Keep personal information out of references; integrate access control and approval workflows before exposing these methods.

## Compliance semantics

| Control | Enforcement |
|---|---|
| Allowlist | RequireAuth plus holder opt-in and issuer MPTokenAuthorize |
| Clawback | Issuance CanClawback; works against locked and revoked holdings |
| Ban | Durable local ban, issuer revocation, holder lock, full clawback, zero-balance verification |
| Individual freeze | Holder lock, issuer DepositAuth, and backend mint guard; unfreeze preserves approval |
| Global freeze | Issuance lock, issuer DepositAuth, and backend mint guard; unlocking leaves individual locks intact |

**MPT locks alone permit redemption to the issuer.** Creation therefore enables issuer **DepositAuth**, and the profile requires no account or credential DepositPreauth objects. This account-wide setting blocks unsolicited deposits/redemptions even when the token is unlocked. A future redemption service should use an authenticated, issuer-controlled process; do not introduce preauthorizations or disable DepositAuth without revisiting the freeze guarantee. Clawback remains available during freezes by design.

**Issuer-originated payments also bypass native MPT locks**, as the testnet probe demonstrates. `mint()` checks both global and holder locks before signing. Therefore the complete freeze guarantee is a combination of ledger controls and exclusive backend signing policy, not an unconditional ledger-level ban on issuer payments. Do not bypass `MptIssuer` with raw signing or low-level `Ledger.send` for issuer token payments. If compliance requires preventing even the issuer from sending to an approved frozen holder at protocol level, the requested approved-and-frozen state cannot provide that guarantee with current MPT locks. Revoking approval is a different state.

Escrow, DEX trading, transfer fees and confidential balances are disabled. There are no balances hidden in escrow or trading objects that the ban would fail to drain. Holder transfers are enabled, so successful and blocked peer payments actually test the controls.

A ban is a multi-transaction operation, not atomic. The policy is persisted first, then authorization is revoked before the balance is drained. A failed call is **incomplete**, and must be retried using the same operation ID until completion. Enforcement begins as transactions validate, not at API invocation. RequireAuth prevents a banned holder from restoring approval by deleting/recreating its holding. Only issuer authority can reapprove it; this module refuses to do so across restarts. Anyone with independent issuer signing access can override issuer controls, so route signing through one controlled service.

## Persistence and recovery

The SQLite journal uses WAL and synchronous FULL, with an exclusive directory lock. Public API workflows and individual submissions are serialized. Use one writer per issuer and one persistent journal; this is not a distributed multi-writer service. Back up the database and its WAL consistently. Never share the issuer key with another sequence-number writer.

Every transaction persists its exact signed bytes, hash, intent digest and ledger expiry **before** network submission. Repeated operation IDs replay their validated result; conflicting intents are rejected. Transport ambiguity, queued transactions and past-sequence errors resolve the original hash. There is no blind retry with a new sequence, which could duplicate minting or clawback. Unresolved transactions block new submissions.

After a normal failure, rerun the demo with the same seed and `.state` directory. It resumes completed steps and preserves holder identity. If the process was killed, first establish that the old writer is dead, then remove only `.state/issuer.sqlite.lock`. Retry the original operation. If a signed transaction expired without validation, reconcile its hash and sequence against complete validated ledger history before retiring it and issuing a new operation ID; absence from a single RPC response is not proof it never executed. The library deliberately stops for this exceptional reconciliation instead of risking duplicate financial effects.

The demo encrypts generated holder seeds with AES-256-GCM using a key derived from the supplied issuer seed. Seeds never appear in result/evidence files. Keep `.state` private and backed up; retain the issuer seed in a secret manager. An institutional deployment should adapt the signing boundary to its audited custody/HSM service and operational controls.

## Verification and evidence

`evidence/transactions.json` records validated hashes, result codes and metadata, including negative tests. `evidence/verification.json` captures final issuance, account and holder objects at a single ledger hash. The demo tests unapproved receipt, successful peer movement, locked peer sending/receipt, blocked redemption, backend mint guards, unlock restoration, partial clawback, global freeze and restoration, and receipt after C deletes/recreates its holding. It records one successful issuer-to-locked-holder protocol probe and claws that single token back. It also checks that the module rejects reapproval, unfreeze and mint for C.

Final expected balances: A=500 approved/unlocked; B=700 approved/locked; C=0 unauthorized/banned. C's recreated empty holding is unlocked but cannot receive without issuer approval. Issuance outstanding amount=1200, global lock off, capabilities=102. `npm run verify` checks this independently of the demo's transaction execution.

## Operational limits

Signing is local; fees are capped at 0.01 XRP and every signed transaction has LastLedgerSequence. Testnet resets can invalidate saved IDs; the module fails rather than silently recreating supply. State and amendment checks assume a trustworthy testnet RPC. Production deployment still requires custody integration, independent review, monitoring for configuration changes and amendment upgrades, and a deployment-specific recovery procedure. This testnet implementation and its evidence do not constitute an external security audit or regulatory certification.
