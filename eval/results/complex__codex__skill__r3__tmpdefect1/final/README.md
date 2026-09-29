# XRPL MPT issuer backend (testnet)

Strict TypeScript implementation using the pinned `xrpl` npm package. The reusable API is exported from `src/index.ts`; the live integration demo is `scripts/demo.ts`.

## Compliance semantics

**Native MPT freezes are not an absolute halt:** locked holders can still make direct redemption payments to the issuer. Live testnet also permits payments **from the issuer to a locked holder**. The demo exercises issuer-payment exceptions and restores balances after each probe. Clawback remains available while locked. The issuer module additionally refuses to mint while the holder or issuance is locked, but that is a backend policy guard: the issuer key can bypass it. Therefore this implementation does **not** satisfy a literal requirement that *no balance may change under any circumstances while frozen*. A backend cannot prevent a holder from submitting an otherwise valid transaction directly to XRPL. Compliance must account for this protocol behavior before deployment.

| Control | Implementation |
| --- | --- |
| Allowlist | `tfMPTRequireAuth` at creation. Holder signs their own opt-in; issuer separately grants authorization after backend KYC approval. |
| Clawback | `tfMPTCanClawback` at creation; `Clawback` with MPT amount and `Holder`. Amounts above balance drain the available balance. |
| Ban | Persist ban intent; revoke authorization and await validation; lock holder; drain remaining balance; verify zero and no authorization; mark complete. |
| Holder freeze | `MPTokenIssuanceSet`, `Holder`, `tfMPTLock` / `tfMPTUnlock`. Blocks incoming/outgoing transfers involving other holders. Issuer-payment exceptions above. |
| Global freeze | Same lock transaction without `Holder`. Applies to this issuance, not the issuer's other assets. Same redemption exception. |

Issuance flags are `102` (`CanLock | RequireAuth | CanTransfer | CanClawback`). Trading, escrow and confidential balances are disabled, keeping all holdings directly recoverable. The module rejects attaching to issuances with these additional capabilities or a permissioned domain. This uses MPT controls, not trust-line AccountSet flags. Asset scale is zero: `"500"` means exactly 500 indivisible token units. Maximum supply defaults to 1,000,000,000 units. No backing, banking, redemption settlement or actual KYC service is implemented.

Bans are resumable workflows, not atomic ledger transactions. Revocation validates before draining; receipts cannot replenish the holder while the drain is in progress. A holder could move funds before revocation validates. An interrupted ban remains blocked in the backend; call `ban()` again to resume. A holder's own opt-in cannot grant issuer authorization. There is no unban API. The issuer key can override ledger controls outside this module, so restrict access to it.

## Run

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
npm test
export XRPL_ISSUER_SEED='<supply through your secret manager>'
npm run demo
npm run verify
```

The demo checks that the seed matches `rnKzFF5SvNHU3pNF66YMPSBHR7H75DQZdy` and that the server reports testnet network ID 1. It funds three holders with 5 test XRP each from that issuer. It checks current ledger reserves before funding. Each account and its holding consume reserves; expected rejected transactions also consume small XRP fees. The runner caps each fee at 0.01 XRP. It never sends a seed to a server.

The demo writes:

- `result.json`: exactly the requested issuance ID and three classic addresses, written after final validation.
- `verification.json`: issuance and holder objects read at one validated ledger index.
- `demo-audit.json`: executed demo steps and transaction hashes, ledger indexes and results.
- `transaction-receipts.json`: every validated transaction receipt, including issuance creation and all ban substeps, without signed transaction blobs.
- `.local/state.json`: private transaction journal, idempotency records, ban records and demo checkpoints.
- `.local/holders.enc.json`: AES-256-GCM encrypted holder seeds, using an HKDF key derived from the issuer seed. Preserve this file and the issuer seed to recover these test holder wallets.

Re-running the demo resumes checkpoints and does not intentionally create another issuance or repeat minting. Do not delete `.local` to retry an uncertain transaction. `.local/demo.lock` excludes concurrent demo processes; after a crash remove a stale lock only after confirming no demo is running. `npm run verify` is read-only and needs no seed. Testnet resets can invalidate all persisted ledger references.

## Backend integration

```ts
import { Client, Wallet } from 'xrpl';
import { FileStore, TransactionRunner, XrplLedgerReader, MptIssuer } from './src/index.js';

const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const wallet = Wallet.fromSeed(process.env.XRPL_ISSUER_SEED!);
const store = await FileStore.open('/secure/private/issuer-state.json');
const runner = new TransactionRunner(client, wallet, store);
const reader = new XrplLedgerReader(client);
const issuer = new MptIssuer(existingIssuanceId, runner, reader, store);
await issuer.checkCapabilities();
// Holder has already signed MPTokenAuthorize without Holder.
// Backend has authenticated this request and completed KYC.
await issuer.approve(holderAddress, 'kyc-case-123:approve');
await issuer.mint(holderAddress, '500', 'issuance-order-456');
await issuer.freezeHolder(holderAddress, 'case-789:freeze');
await issuer.clawback(holderAddress, '100', 'case-789:clawback');
await issuer.unfreezeHolder(holderAddress, 'case-790:unfreeze');
await issuer.freezeGlobal('incident-42:freeze');
await issuer.unfreezeGlobal('incident-42:unfreeze');
await issuer.ban(holderAddress, 'case-791:ban', 'Compliance decision reference');
await client.disconnect();
```

Call `MptIssuer.create(runner, reader, store, operationId, maximumAmount)` to create a new issuance. No holder secrets are needed by the issuer module. The `Signer` interface accepts a wallet or an asynchronous signing adapter suitable for a custody/HSM service. All amounts are positive canonical integer strings and never JavaScript floating-point numbers.

## Transaction safety and deployment boundaries

Every write needs a unique business operation ID. Reuse that ID only to reconcile/retry the same logical operation. Reusing an ID with changed transaction content fails. Successful and validated failed results are cached. The runner autofills sequence, fee and `LastLedgerSequence`, persists signed bytes before submission, verifies validated metadata, and returns the transaction hash and ledger index. It serializes operations per account.

An uncertain submission raises `UnresolvedTransaction` and blocks new operations for that signer. Retry the same operation to query its hash and resubmit the same signed bytes. `submitAndWait` provides reliable submission/queue waiting; this module never blindly signs a replacement for `terQUEUED`, `tefPAST_SEQ`, timeouts or expiry. A validated `tec*` result raises `LedgerFailure` and consumes the fee. A failed or expired transaction without a definitive validated result requires reconciliation against a server with the complete relevant ledger history before a replacement operation may be authorized. Keep the journal; do not reset it to bypass an unresolved operation.

The file adapter is for a **single writer**. Use one `MptIssuer` instance per issuance and one shared runner per signing account; all issuer operations must flow through that worker. The demo enforces a process lock. A distributed deployment needs a durable transactional store, an account-wide distributed lock/queue, and coordinated ban policy transactions. Merely replacing the store without coordinating workers is insufficient. Back up the ban database; otherwise an application could accidentally reapprove a previously banned account. Preserve transaction journals as signing authorizations, with restricted access.

Backend authentication, operator authorization, KYC evidence, secret custody, database redundancy, monitoring for out-of-band issuer transactions, and incident escalation are deployment responsibilities. This implementation and testnet exercise are not an independent security audit or certification of regulatory compliance. Mainnet use is deliberately blocked by the runner's network check.

## Protocol references

- [MPT compliance controls and redemption exception](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset)
- [Clawback and MPT Holder field](https://xrpl.org/docs/references/protocol/transactions/types/clawback)

The live demo is the integration test: it asserts allowlist rejection, successful transfers, incoming/outgoing freeze rejection between holders, issuer-payment exceptions, backend mint guards while locked, clawback while frozen, bans, backend ban guards and final state. Unit tests cover serialization, amount bounds, durable idempotency, unresolved submissions, fee limits and an interrupted ban whose clawback already changed the ledger.
