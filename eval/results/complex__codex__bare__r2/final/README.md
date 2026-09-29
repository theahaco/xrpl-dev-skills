# Regulated MPT issuer (XRPL testnet)

Strict TypeScript, pinned `xrpl` dependency, reusable issuer API and an executable testnet integration demo. Requires Node.js 22.13+ (Node 25 used for this run) for built-in SQLite. No issuer seed is stored in source or public results.

## Critical freeze semantics

**Native MPT locks do not provide an absolute stop on every movement. A frozen holder can still redeem to the issuer.** Global lock has the same redemption exception. Administrative clawback remains possible. This module provides the native ledger locks; it cannot honestly promise the stricter “cannot send anywhere” / “all movement” requirements. Do not certify that requirement as satisfied by this implementation. The issuer API also refuses minting to locked holders or during global lock, but API checks cannot control other software using the issuer key.

See the [MPT specification](https://xls.xrpl.org/xls/XLS-0033-multi-purpose-tokens.html), [authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize), [locking](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset), and [clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback) references. Clawback burns supply; it does not credit a token balance to the issuer.

## Run

```sh
npm ci
npm run build
npm test
export ISSUER_SEED='your testnet seed'
npm run demo
npm run verify
```

The demo requires the supplied issuer address, checks testnet network ID 1, funds three new wallets with 10 test XRP each, and uses the issuer for all administrative transactions. It sets AssetScale=0: API amounts are integer strings in ledger units, so 500 means 500 tokens. Supply cap is 1,000,000,000. The module enables RequireAuth, CanLock, CanTransfer and CanClawback at creation. DEX trading, escrow and confidential balances are not enabled, keeping holdings directly recoverable. No trust-line AccountSet flags are required.

The issuance uses minimal test metadata, not a complete XLS-89 branding payload; the SDK warns about missing icon/issuer-name fields and the seven-character ticker. This does not change ledger enforcement. Supply real issuer branding and hosted assets before a separate production issuance.

`result.json` is the requested ID/address map. `verification.json` contains ledger entries read from a **single validated ledger hash**. `audit.json` records transaction bodies, hashes, validated ledger indexes and metadata, including expected failures. These public artifacts contain no seeds. `.private/demo.sqlite` contains holder seeds, durable bans, checkpoints and the signed transaction journal; it is mode 0600, ignored by Git, and must be kept on protected persistent storage. Testnet can reset.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer, TransactionRunner, TESTNET } from './src/issuer.js';
import { SqliteStore } from './src/storage.js';

const client = new Client(TESTNET);
await client.connect();
const store = new SqliteStore('.private/issuer.sqlite');
store.assertNoPending();
const runner = new TransactionRunner(client, store);
const wallet = Wallet.fromSeed(process.env.ISSUER_SEED!);
const token = new MptIssuer(runner, wallet, issuanceId, store);
await token.assertCapabilities();
await token.approve(holder); // only after your backend's KYC decision
await token.mint(holder, '500');
await token.freeze(holder);
await token.unfreeze(holder);
await token.clawback(holder, '100');
await token.freezeAll();
await token.unfreezeAll();
await token.ban(holder);
await client.disconnect();
store.close();
```

Use `MptIssuer.create(runner, wallet, store)` once to create a new issuance. Holders first opt in by signing their own `MPTokenAuthorize` without `Holder`; the backend then approves them using the issuer signature. The issuer module never needs holder private keys. Only the demonstration controls holder wallets.

`approve`, `mint`, `freeze`, `unfreeze`, `freezeAll`, `unfreezeAll`, `clawback`, and `ban` resolve only after validated success. `holding` and `issuance` read validated state. Amount validation uses BigInt, never floating point. Clawback takes a positive integer and removes up to the holder's current balance; a zero balance produces a ledger error.

## Ban guarantees and recovery

`ban` writes durable deny-list intent first, revokes ledger authorization, locks the holding, claws back all remaining units, and verifies zero balance and no authorization. It is a multi-transaction operation, **not atomic**. Until revocation validates, a holder may transact. A partial failure must be reported as incomplete and resumed, never as a successful ban. Once revocation validates, new receipts are denied even if clawback is still pending. Repeat `ban` after reconciling any uncertain transaction to finish safely.

The permanent local deny-list prevents this API from reapproving, unlocking or minting to a banned address. Deleting and recreating a zero-balance holder entry does not restore issuer authorization. There is no irreversible ledger “ban” bit: a person with unrestricted issuer signing authority can deliberately reauthorize an address. Protect that authority and the ban database. The ban applies to an address, not to a real-world identity's other addresses.

## Submission and operating contract

- Serialize **all operations for an issuer**, including complete ban workflows. This implementation serializes one module instance and transaction runner in process. A deployment with multiple workers must provide a distributed account lock or a single signing worker; multiple independent instances are not safe. Do not use the issuer wallet concurrently elsewhere.
- Provide business request IDs and durable job deduplication in your backend. Financial operations are not automatically retried. SQLite is a local single-worker adapter, not a distributed job system.
- Every signed transaction is durably journaled before network submission. Fees are capped at 1,000 drops and transactions expire using autofilled LastLedgerSequence. Success requires validated metadata with `tesSUCCESS`; validated `tec` failures carry a `LedgerFailure` receipt and consume fees.
- A timeout, ambiguous transport result or journal failure raises `SubmissionUnknown` with the signed hash and halts the runner. Query `tx` by that hash using a server with the relevant ledger history. If validated, persist its actual receipt. If absent, establish that the validated ledger has passed LastLedgerSequence and that the full candidate ledger range is available before concluding non-inclusion. Until then, rebroadcast only the identical signed blob if needed; never re-sign an uncertain mint or clawback. Do not delete pending records to bypass this gate.
- The demo checkpoints stages. After an interrupted stage it refuses automatic continuation, because a financial transaction may have validated just before the stage checkpoint. Inspect journal receipts and on-ledger effects, mark the stage complete only when verified, then clear `runningStep`. A fully completed demo can be rerun to reverify without issuing another token. Keep its database; deleting it intentionally starts a new demo.
- Before production: integrate your authenticated KYC/compliance decision service, access controls, protected signing service, durable audit retention and alerting, job recovery, independent security review, and an approved resolution of the redemption exception. This testnet integration is not a certification of regulatory compliance.

The tests cover amount precision/input bounds, persisted bans, ambiguous submission handling, and recovery after a partial ban. The live demo tests approval enforcement, bidirectional holder lock enforcement, post-unlock transfers, partial clawback, global lock enforcement, ban enforcement (including issuer payments), and final supply/holder flags. It also explicitly demonstrates redemption to the issuer under both holder and global locks, then restores A's balance to 500.
