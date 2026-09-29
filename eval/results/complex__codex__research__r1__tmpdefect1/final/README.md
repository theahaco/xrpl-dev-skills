# Regulated MPT issuer (XRPL testnet)

Strict TypeScript issuer module, a resumable live demo, and independent final-state verification. Uses pinned `xrpl` 5.3.0 and a lockfile. Research is recorded in [research/README.md](research/README.md).

**Compliance limitation:** native MPT freezes block transfers between holders, but permit payments involving the issuer in both directions. Clawback also remains possible. The module blocks issuance while locked, but a holder can redeem directly without its cooperation. Therefore this implementation does **not** promise a literal halt to every balance change. The demo proves issuer-payment and redemption exceptions for both individual and global freezes, leaving A with the requested balance. If preventing redemption during a freeze is mandatory, this native MPT design does not meet that requirement. Do not represent it to compliance as an absolute freeze.

The token enables authorization, individual/global locking, clawback, and holder transfers at creation. Trading, escrow and confidential balances are disabled, and no permissioned domain can bypass individual approval. Amounts are integer strings in base units; the demo uses `AssetScale: 0`, zero transfer fee and a maximum supply of 1,000,000,000,000. XRP funding is separate: each new holder receives 10 test XRP from the issuer.

## Run

Use Node.js 22 or newer (tested with the existing Node 25.9.0 runtime).

```sh
npm ci
npm run check
npm test
npm run build
# Supply the issuer seed through your environment or secret manager.
npm run demo
npm run verify
```

The demo expects `ISSUER_SEED` and verifies it derives the supplied issuer address. It pins the testnet endpoint and verifies network ID 1 and required enabled amendments before signing. Never use a mainnet seed. No seed is embedded in source or public artifacts.

`result.json` is written only after all final-state assertions pass. `verification.json` records issuance and holder objects from one validated ledger hash. `demo-evidence.json` contains operation names, validated hashes, result codes and transaction metadata, including the negative payment tests. `npm run verify` independently reads the ledger without secrets.

The existing demo state is resumable: rerunning uses the same issuance and holders. It does not create another token or repeat successful funding/payments.

## Backend integration

```ts
import { Client } from 'xrpl';
import { MptIssuer } from './src/issuer.js';
import { FileStore } from './src/store.js';
import { TESTNET, TransactionRunner, type Signer } from './src/ledger.js';

// signer.address is the classic issuer address; signer.sign returns a signed blob/hash.
// Supply this from your custody service; the module does not need a seed.
async function approveAfterKyc(signer: Signer, issuanceId: string, holder: string) {
  const store = new FileStore('/durable/issuer-state');
  const client = new Client(TESTNET, { maxFeeXRP: '0.001' });
  try {
    await client.connect();
    const runner = new TransactionRunner(client, store);
    const issuer = await MptIssuer.open(issuanceId, runner, signer, store);
    // Holder first submits issuer.enrollment(holder) with their own signer.
    await issuer.approve(holder, 'kyc-case-123/approve');
    await issuer.issue(holder, '500', 'settlement-456/issue');
  } finally {
    await client.disconnect();
    store.close();
  }
}
```

Create an issuance once with `MptIssuer.create(runner, signer, store, operationKey)`; save the returned `id`. Reopen it using the same durable policy store. Opening an existing issuance with missing policy state fails closed. The backend is responsible for KYC decisions and access control; `approve` does not perform KYC itself.

| Method | Behavior |
| --- | --- |
| `enrollment(holder)` | Unsigned holder opt-in transaction; requires holder signature. |
| `approve(holder, key)` | Grants ledger authorization, rejecting permanently banned addresses. |
| `issue(holder, amount, key)` | Issues an exact amount to an approved, unlocked holder. |
| `clawback(holder, amount, key)` | Claws back up to the requested amount, capped by the available balance. Zero and invalid amounts are rejected. |
| `freezeHolder(holder, frozen, key)` | Sets/clears the holder lock; redemption exception applies. |
| `freezeAll(frozen, key)` | Sets/clears the issuance lock independently of holder locks. |
| `ban(holder, reason)` | Persists the ban, revokes authorization, drains the balance, verifies zero and no authorization. Repeating resumes the same ban. |
| `inspect(holders)` | Reads one validated ledger snapshot and checks the compliance profile. |

Bans are multi-transaction workflows, not atomic ledger operations. A ban is complete only after the method resolves. A failure leaves the address denied by local policy and the ban pending; reconcile and resume it. Authorization is revoked **before** draining, preventing new receipts during the drain. A holder can delete/recreate an empty MPToken, but the new object is still unauthorized. The demo explicitly tests this attack. The durable denylist prevents the backend from granting authorization again. XRPL has no irreversible address-ban primitive: someone independently controlling the issuer key could override policy. All issuer signing must go through the controlled backend.

## Reliability and operations

Use one active module instance, runner and state directory per issuer, with exclusive custody of its transaction sequence. Keep the state directory on a durable local filesystem, back it up, and restrict access. This implementation is a single-writer service, not a distributed database. Multiple backend workers must route writes through that service. Do not use multiple state directories for the same issuer.

The file store uses atomic replacement, file/directory fsync and an exclusive process lock. `.private/` holds demo holder seeds, policy and signed transaction blobs with restrictive permissions and is gitignored. A stale `writer.lock` is deliberately not stolen: confirm the old process is dead, reconcile the journal, then remove that lock before restarting. Never delete the journal or ban policy to clear an error.

Caller-supplied operation keys are mandatory for value-changing actions. A key is tied to its transaction intent. Signed transactions are persisted before sending; retries query the same hash or submit the identical blob. Only validated metadata is accepted as success. Any unresolved transaction blocks new transactions. The module never automatically signs a replacement payment after a timeout. Expired unresolved transactions require an operator to check complete validated history; an absence response from a server alone is not sufficient evidence. If a transaction is definitively failed, use a new operation key only after reviewing the recorded failure.

Every signed transaction has an expiry and a maximum 1,000-drop fee. The signing service's output is checked against the prepared transaction. Validation failures include the transaction hash. Control methods read back the resulting flags, and bans verify balance and authorization. Keep external transactions and capability changes out of this managed account; profile checks reject incompatible issuances.

Tests cover exact amounts, overflow, exclusive locking, policy persistence, queue failures, network/amendment guards and recovery after a submission succeeds but its response is lost. The live demo tests authorization, both freeze directions, issuer-to-frozen payments, redemption exceptions, partial clawback, global locking/unlocking, bans, holder re-enrollment and final supply/balances. Production custody, service authentication, KYC workflows, monitoring and durable deployment remain integration responsibilities; this testnet run is not a security audit or regulatory certification.
