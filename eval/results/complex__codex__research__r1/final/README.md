# XRPL MPT issuer

Strict TypeScript issuer module and a real testnet compliance demonstration. Uses npm's latest stable `xrpl` **5.3.0**, pinned in the lockfile. Research and amendment evidence are in [research/README.md](research/README.md).

The completed demo writes [result.json](result.json), [verification.json](verification.json), [demo-report.json](demo-report.json), and [demo-transactions.json](demo-transactions.json). The transaction file records validated hashes, ledger indices, and result codes, including deliberately rejected transfers. The report also records completed application checks and explains the historical probe ID `deny-issuer-to-frozen-A`, whose observed result is **tesSUCCESS** because of the native issuer exception. Final verification reads all balances and flags at one validated ledger.

| Account | Final token balance | Authorization | Individual lock |
| --- | ---: | --- | --- |
| A | 500 | Approved | Off; exercised on/off |
| B | 700 | Approved; originally received 1,000, then 300 clawed back | On |
| C | 0 | Revoked; permanently banned by backend policy | Not required |

Global lock is off after exercising on/off. Outstanding supply is 1,200. Amounts are integer base units, `AssetScale=0`; no floating-point arithmetic is used. Escrow, DEX trading, confidential balances and permissioned domains are excluded from this compliance profile.

## Freeze semantics and issuer account policy

**Native MPT locks do not prevent payments involving the issuer on this testnet.** The live demo proved that a raw issuer payment to locked A succeeds. The implementation therefore uses three controls together:

1. MPT individual/global locks block holder-to-holder sending and receiving.
2. The issuer account has **DepositAuth enabled with no DepositPreauth entries**. This blocks holder-initiated payments back to the issuer, including redemption while frozen.
3. `MptIssuer.issue()` refuses issuance to locked holders, during global lock, to unauthorized holders, or to banned holders.

DepositAuth is **account-wide and remains enabled**. Direct incoming XRP and token payments to this issuer generally require authorization; XRPL has a small-XRP reserve exception. Direct holder redemption is also blocked when unlocked. This module uses issuer-controlled clawback for token removal; any associated off-ledger redemption settlement belongs to your backend. Do not create DepositPreauth entries or disable DepositAuth while using this profile. The module checks these prerequisites and fails closed if they change.

The issuer is a privileged authority: someone who can sign arbitrary issuer transactions can bypass the application mint policy, reauthorize a banned address, or unlock the token. Restrict issuer signing to this service. There is no claim that native MPT locking alone provides an absolute freeze against the issuer itself.

## Run

Node.js 22 or newer is required; this workspace used the existing Node.js 25.9.0. No seed is embedded in the source or public artifacts.

```sh
npm ci
npm run check
npm test
npm run build

# Set ISSUER_SEED through your secret manager or shell environment first.
npm run demo

# Read-only verification; no seed needed.
npm run verify
```

The demo validates the seed against `rG7kN3XvQ2T3UvSzT55VKLXQjFrGw1LP3f`, funds three new wallets with 10 test XRP each from that issuer, and uses the official testnet endpoint. It resumes its existing `.state` directory, rather than silently issuing a second token. Re-running a finished demo verifies its current final state. Do not delete `.state` to recover from a failure.

Holder seeds are stored only in ignored `.state/holders.json`, with mode `0600`, for demo resumption. The issuer seed is read only from the environment. `.state` also contains ban policy and signed transaction blobs; protect it as sensitive operational state and retain backups. Public JSON artifacts contain no private keys.

## Backend API

Use one `Transactions` writer and its `FileStore` for the dedicated issuer. Keep the `Client`, store and signer alive for the service lifecycle. Close the store only after all work has stopped.

```ts
import { Client, Wallet } from 'xrpl';
import { FileStore, Transactions, MptIssuer } from './src/index.js';

const wallet = Wallet.fromSeed(process.env.ISSUER_SEED!);
const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const store = new FileStore('.state/backend', wallet.classicAddress);
const transactions = new Transactions(client, store);

// Account-wide setup; use a dedicated issuer as described above.
await MptIssuer.configureIssuer(transactions, wallet, 'setup/deposit-auth');
const issuer = await MptIssuer.create(transactions, wallet, 'issuance/create');
// Existing issuance: MptIssuer.attach(transactions, wallet, issuanceId).

// Have the holder sign issuer.optInTransaction(holderAddress) first.
await issuer.approve(holderAddress, 'kyc/123/approve');
await issuer.issue(holderAddress, '1000', 'mint/456');
await issuer.clawback(holderAddress, '300', 'clawback/789');
await issuer.freezeHolder(holderAddress, true, 'case/321/freeze');
await issuer.freezeHolder(holderAddress, false, 'case/321/unfreeze');
await issuer.freezeGlobal(true, 'incident/654/freeze');
await issuer.freezeGlobal(false, 'incident/654/unfreeze');
await issuer.ban(holderAddress, 'KYC approval withdrawn', 'case/987/ban');

await client.disconnect();
store.close();
```

`holderAddress` in this example is your KYC-approved classic address. KYC decisions and access control are backend responsibilities. The issuer module never needs holder private keys; only the demo holds them to exercise adversarial transactions. `Signer` also accepts an asynchronous signing adapter, so backend signing can be isolated behind an HSM/service.

Every mutation takes a stable business operation ID. Repeating an ID returns its recorded validated outcome; using it with different transaction content is rejected. Clawback saturates at the holder's available balance if the request exceeds it, following XRPL semantics. Zero/negative/fractional/out-of-range amounts are rejected. A clawback does not transfer the removed tokens into an issuer balance; it reduces outstanding supply.

Optional issuance metadata is accepted as the SDK's `MPTokenMetadata` type, encoded with `encodeMPTokenMetadata`, and checked against XLS-89. Metadata is otherwise omitted. The existing demonstration issuance carries simple descriptive JSON from the initial live run; it does not satisfy all XLS-89 discovery fields and cannot be updated while `DynamicMPT` is disabled. Its compliance flags and amounts are unaffected.

## Ban and recovery guarantees

A ban is a resumable workflow: persist a permanent local ban, revoke on-ledger holder authorization, claw back up to the full maximum balance, then verify zero balance and no authorization. The method reports completion only after those checks. It is not an atomic ledger transaction. Before revocation validates, a holder can still move tokens; there is no retroactive confiscation of transfers already validated. After revocation, incoming payments are denied on-ledger, including after the holder deletes/recreates its empty MPToken entry. The demo proves this behavior.

The signed blob, hash and expiry are fsynced **before** submission. Only validated metadata can mark a transaction successful. A timeout or transport error leaves an unresolved journal entry and blocks unrelated transactions. Resume the same operation ID to reconcile by hash and, if necessary, resubmit the identical signed blob. Never retry an uncertain mint/clawback under a new ID.

An expired or otherwise unresolved transaction is deliberately not automatically replaced. An operator must use a trusted server with complete ledger history to establish the original outcome or definitive non-inclusion before migrating/replacing the pending business operation. Do not erase the pending entry merely because one `tx` lookup returned `txnNotFound`. This conservative behavior trades availability for avoiding duplicate financial effects.

The local adapter enforces a single writer with an exclusive lock file, atomic rename and fsync. After a hard process crash, verify that the prior worker has exited and reconcile its journal before removing `.state/writer.lock`. For multiple hosts, use a transactional database plus a distributed issuer lock; the local filesystem adapter is not a distributed coordination mechanism. Do not run separate writers or external issuer signers against the same account. The module checks testnet network ID, required amendments, ledger freshness, issuance profile, account policy, fee ceiling and transaction expiry.

## Validation

Unit tests cover numeric boundaries, exclusive writer locking, idempotency conflicts, uncertainty, restart reconciliation, validated failures, wrong network, fee limits, ban recovery/order, prohibited reapproval/unfreeze, lock scopes, account prerequisites and issuer mint safeguards. The live demo additionally checks allowlisting, 300-unit clawback, both lock scopes, redemption blocking, unlocking, ban draining, and holder entry recreation. Run `npm run verify` whenever a fresh snapshot is needed; testnet can reset and accounts can later change.

This is a tested implementation with explicit operational constraints, not an independent security audit or a claim of regulatory certification.
