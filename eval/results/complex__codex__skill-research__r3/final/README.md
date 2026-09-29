# Regulated MPT issuer (XRPL testnet)

Strict TypeScript issuer library using xrpl 5.3.0. The live demo issues from `rhXcp3PUXhNiJ2bA5uchbKjn71BrKv9Vck`; `result.json` identifies its token and holders. Research and amendment evidence are in [research/README.md](research/README.md). Final ledger evidence is in `verification.json`, and validated transaction receipts are in `transactions.json`.

```sh
npm ci
npm test
# Supply the testnet seed via your secret manager/environment; do not put it in source.
export ISSUER_SEED='<testnet issuer seed>'
npm run demo
npm run verify  # Read-only; no seed needed.
```

Node 24+ is required for built-in SQLite (tested on the existing Node 25.9.0 runtime). The demo is resumable using `.private/demo.sqlite` and an AES-256-GCM encrypted holder-key vault. Keep both files and the issuer seed to resume. No plaintext seed is written. The vault is a demo convenience; use managed key custody for a deployed service.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { Journal, Runner, TESTNET } from './src/runtime.js';
import { MptIssuer } from './src/issuer.js';

const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
await client.connect();
const journal = new Journal('/secure/existing-directory/issuer.sqlite');
const runner = new Runner(client, journal);
const wallet = Wallet.fromSeed(process.env.ISSUER_SEED!);
const issuer = new MptIssuer(runner, wallet, existingIssuanceId);
try {
  await issuer.approve(holderAddress, 'kyc-case-123/approve');
  await issuer.issue(holderAddress, '500', 'allocation-456');
  await issuer.freeze(holderAddress, true, 'incident-789/freeze');
  await issuer.freeze(holderAddress, false, 'incident-789/unfreeze');
  await issuer.clawback(holderAddress, '300', 'recovery-123');
  await issuer.globalFreeze(true, 'incident-800/start');
  await issuer.globalFreeze(false, 'incident-800/end');
  await issuer.ban(holderAddress, 'Compliance case reference', 'ban-900');
} finally {
  await client.disconnect();
  journal.close();
}
```

For a new issuance, call `MptIssuer.create(runner, signer, stableOperationKey)`. It enables issuer DepositAuth and creates the MPT. Holders first sign their own `MPTokenAuthorize` without a Holder field. `approve` represents your backend's completed KYC decision; the library does not perform KYC or authenticate API callers. Keep this API behind your compliance authorization layer.

Amounts are positive integer **atomic units**, supplied as strings, capped at 2^63−1. The created issuance uses AssetScale 0, zero transfer fees, and capabilities CanLock, RequireAuth, CanTransfer and CanClawback. Clawback recovers up to the requested amount; above-balance requests drain all available tokens, per protocol semantics.

## Compliance model

- Native MPT authorization enforces receipt restrictions on the ledger. Approval requires a holder opt-in; self-enrollment alone cannot receive tokens.
- Native MPT locks block holder-to-holder transfers, but issuer-originated payments can bypass the lock. The module checks the holder/global lock before new issuance, so all issuer signing must go through the module. Native locks also allow direct redemption; this module additionally requires issuer **DepositAuth with no preauthorizations** to block that exception. This setting remains enabled even outside freezes, so ordinary direct redemption/deposits to this dedicated issuer are blocked. A business redemption service can validate a redemption request and use clawback.
- A ban durably records policy before submitting transactions, then locks, revokes authorization, claws back the full balance, and verifies zero/unauthorized. It is a multi-transaction operation, not atomic. Until the locking transaction validates, the holder can still transact. Errors mean the ban is incomplete; retry the same operation key. Partial progress stays restrictive.
- Recreating a deleted holding removes its lock bit but cannot restore authorization. The demo proves payments still fail. Durable policy rejects later approval, issuance or unfreeze for banned addresses; there is no unban API.
- Global freeze blocks holder transfers on-ledger and new issuance through this module. It cannot prevent a privileged issuer from bypassing the module and signing directly. Administrative clawbacks remain possible; the demo bans C during the global freeze.

## Operation and recovery

Use **one MptIssuer instance and one writer for each issuer account**, including all transactions outside this library. The journal lock excludes another process using the same journal. The in-process queue serializes issuer operations. A distributed deployment must route this account to a single worker and durable volume; separate journals/processes are not coordinated. Do not externally change issuance flags, create deposit preauthorizations, or sign competing issuer transactions.

Every transaction is signed locally with a fee cap and LastLedgerSequence, then saved to SQLite with FULL synchronous durability **before submission**. A stable operation key must identify the same request forever. On retry, the runner looks up the existing hash and only resubmits the identical signed blob. It never silently signs a second issuance/payment after a timeout. Validated `tec` failures are recorded and raised as `TransactionFailure`; no transport error counts as a successful compliance action. Unresolved operations block fresh transactions until reconciled. Sequence conflicts and expired transactions require explicit operator reconciliation; there is deliberately no automatic replacement with a fresh sequence.

After a hard process crash, confirm the old worker has stopped before removing the empty `.sqlite.lock` directory. Resume the original job against the same journal. If a transaction expired and its outcome cannot be established from the public node's history, consult a history-capable server and reconcile the hash before proceeding. Never delete journal rows to bypass uncertainty. Retain and back up policy/journal data: the ledger has authorization bits, not a permanent blacklist.

The issuer signer interface can wrap a controlled local signer. For HSM or async signing, adapt the signing boundary and preserve pre-submission persistence. No production-network mode is provided: preflight rejects network IDs other than 1 and checks required amendments. Run independent security review and custody/operational integration before treating this as a deployed regulated service.

## Verification

`npm test` covers amount boundaries, serialized MPT clawback, queue failure handling, durable ban policy, interrupted-ban recovery, issuer freeze policy, process exclusion and journal idempotency, issuance identity and omitted zero-balance fields. The live demo additionally exercises positive transfers, unauthorized receipts, both directions of individual freeze, issuer-policy rejection while frozen, redemption blocking, global freeze, clawback while globally frozen, ban retries, and holder deletion/recreation. A raw issuer-payment probe succeeded while A was locked, exposing the native exemption; its one token was clawed back and both receipts are retained. The library now guards that exemption, with a dedicated unit test. Thus these controls are not an immutable restriction against the issuer itself; the issuer can always change authorizations or sign outside this module. The final verification reads all token balances at one validated ledger index and checks supply = 1,200, A = 500 authorized/unlocked, B = 700 authorized/locked, C = 0 unauthorized, and no global lock.

The demo's minimal token metadata is valid protocol data but omits optional explorer presentation fields (icon and issuer name); the SDK reports XLS-89 presentation warnings. This does not affect token controls.
