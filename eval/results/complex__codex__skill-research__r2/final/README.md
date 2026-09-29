# XRPL MPT issuer backend

Strict TypeScript issuer module and a resumable testnet demo using `xrpl` 5.3.0. The issuance comes from `rp8Jk8kiQzfZeUuUTmWd1bvV4gSpbaQBAW`. See `result.json` for the issuance and holders, `demo-evidence.json` for the verified snapshot, and `transaction-audit.json` for transaction hashes, validated ledger indices, results and metadata.

**Compliance boundary:** native MPT freezes are not absolute immobilization. Live testnet permits direct issuer-to-holder payments and holder-to-issuer redemption while locally or globally locked. The issuer module additionally refuses issuance while locked. A holder can still redeem directly on the ledger, bypassing this backend. Consequently the literal “cannot send or receive” / “freeze all movement” requirements cannot be guaranteed by these native MPT controls. Do not certify this implementation as meeting that stronger requirement. The demo deliberately exercises and records these exceptions. Clawbacks also remain available under locks.

## Run

```sh
npm ci
npm run build
npm test
# Supply the provided test-only seed through your environment/secret manager.
npm run demo
npm run verify
```

`demo` requires `ISSUER_SEED`. `verify` is read-only and needs no seed. The runtime must support `node:sqlite` (Node 24+); development and live execution used the existing Node 25.9.0. Direct dependencies use the newest stable npm releases observed during research, with exact versions and a lockfile. See [research notes](research/README.md) and the raw testnet feature snapshots.

The demo funds three fresh wallets with 5 test XRP each from the issuer. It opts them in, verifies rejection before approval, approves them, issues 500/1000/200, freezes/unfreezes A, claws back 300 from B and freezes B, globally freezes/unfreezes, and bans C. It checks forbidden peer transfers, banned issuer transfers, and C's attempt to delete/recreate its empty holding. Successful test transfers are balanced so final A/B/C balances are 500/700/0 and outstanding supply is 1200. A is approved/unlocked, B approved/locked, C unauthorized, and the issuance is globally unlocked.

Live reserves at research time were 1 XRP/account and 0.2 XRP/object. The demo checks reserves and issuer funding at runtime. Fees are capped at 0.01 XRP per transaction; normal observed fees are much lower. Negative ledger tests also consume fees.

## Backend integration

```ts
import { Client, Wallet } from 'xrpl';
import { Issuer, Ledger, Store, TESTNET, preflight } from './src/index.js';

const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
await client.connect();
await preflight(client);
const store = new Store('/secure/persistent/issuer.sqlite');
const signer = Wallet.fromSeed(process.env.ISSUER_SEED!);
const ledger = new Ledger(client, store);
try {
  // Create exactly once using a stable business operation ID, or attach to an existing ID.
  const token = await Issuer.create(ledger, signer, 'issuance-business-id');
  // const token = new Issuer(ledger, signer, existingIssuanceId);
  // The holder signs optIn(holderAddress, token.issuanceId) using its own wallet first.
  await token.approve(holderAddress, 'kyc-approval-operation-id');
  await token.issue(holderAddress, '500', 'mint-operation-id');
  await token.clawback(holderAddress, '100', 'clawback-operation-id');
  await token.freeze(holderAddress, 'freeze-operation-id');
  await token.unfreeze(holderAddress, 'unfreeze-operation-id');
  await token.freezeGlobal('incident-start-id');
  await token.unfreezeGlobal('incident-end-id');
  await token.ban(holderAddress, 'ban-case-operation-id');
} finally {
  await client.disconnect();
  store.close();
}
```

The sample's `holderAddress` is your backend's KYC-approved classic address. `approve` records ledger authorization; KYC identity checks and who may invoke these privileged methods belong in the calling service. No KYC data is published on-chain. The module accepts a `Signer` interface for integrating a signing service instead of an in-process Wallet. All signing is local to that interface; seeds are never sent to RPC servers.

Amounts are canonical positive integer strings in base units, bounded by 2^63−1. This profile deliberately uses AssetScale 0: `"500"` means 500 tokens, with no fractional units. Clawback reclaims the requested amount up to the holder's available balance. Escrow, DEX trading, domain authorization and confidential balances are excluded from the supported profile. This keeps every holder's token balance visible and reclaimable without relying on disabled amendments.

## Durability and recovery

- Keep one `Ledger` instance and one writer process for each issuer, using one retained Store. Route all issuer signing through it; a second database would bypass concurrency and policy protections. SQLite FULL synchronous transactions persist signed bytes before submission and receipts afterward. A process lock refuses simultaneous Store opens. The in-process queue serializes whole ban workflows as well as ordinary operations.
- Use stable unique operation IDs for business actions. IDs are permanently bound to the exact transaction input. Successful retries return the stored validated receipt without sending again. Changed input under an existing ID is rejected. The low-level `Ledger.send` API must run inside `ledger.exclusive`; the higher-level Issuer methods do this automatically.
- `LedgerFailure` carries a validated failed result and transaction hash. Fees may have been charged. It is never treated as success. `PendingTransaction` means the result is unknown: retry the same operation with the same ID. No second payment is signed. Other new submissions are blocked while an outcome is unknown; queued transactions and lost responses resolve through `submitAndWait` and lookup by hash.
- `ExpiredTransaction` is terminal only after a server proves it searched the entire candidate ledger range, found no transaction, and the validated ledger passed LastLedgerSequence. It releases the submission gate. If the action is still intended, use a new operation ID. Incomplete history or unavailable RPC leaves the gate closed. Transactions recorded before range tracking conservatively search from ledger 1.
- After a process crash, first ensure no writer remains alive, then remove only the stale `.lockfile` alongside the database and rerun the same operation. Preserve the database/WAL; never clear `active`, delete transaction records, or change operation IDs to work around uncertainty. An unavailable complete-history server requires operator reconciliation, not blind resubmission.
- A ban persists policy first, revokes authorization, then claws back the full balance. It is a multi-transaction workflow, not atomic. Only a resolved `ban()` call certifies zero balance and no authorization. If interrupted, rerun the same operation ID until completion. `isBanned()` reports the durable policy intent even while ledger completion is pending. No unban operation is exposed. Approval, issuance and unfreezing reject a banned address.
- A holder may recreate an empty MPToken, but that does not restore issuer approval. A person with independent issuer signing authority can still reauthorize it; the ledger has no permanent address-ban primitive. Protect the issuer keys and policy database accordingly.

The demo keeps encrypted holder recovery seeds in `.local/holders.enc.json`, using AES-256-GCM with a key derived from the supplied issuer seed using scrypt. The issuer seed is not persisted. `.local` is private and gitignored. Back up that directory and the issuer secret separately if you need to operate these test holders later. A rerun uses the same holders, issuance, transaction IDs and checkpoints; deleting this state would create a new demonstration rather than resume it.

## Verification coverage

Unit tests cover amount boundaries, opt-in shape, durable deduplication, unknown submission outcomes, validated failures, concurrency protection and ban interruption/retry. The live demo covers actual authorization, transfers, freezes, clawback, global lock, ban enforcement, deletion/recreation, and direct-issuer lock exceptions. Final reads are all pinned to the same validated ledger. `npm run verify` independently repeats the final ledger assertions without private keys.

Testnet can reset; the JSON files are evidence of the recorded ledger, not a promise about future network state. Before regulated deployment, the direct-issuer freeze exception must be resolved at the requirements/design level. The code has not undergone an independent security audit.
