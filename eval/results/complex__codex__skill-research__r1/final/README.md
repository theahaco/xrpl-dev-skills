Reusable TypeScript issuer module for a restricted, transferable MPT on XRPL testnet. Entry point: `src/issuer.ts`. The module requires issuer authorization for every holder and enables clawback and individual/global locks at creation. No escrow, DEX trading, confidential balance or domain-based authorization is enabled.

**Protocol limitation:** native MPT locks block transfers between holders, but allow holders to redeem to the issuer and allow the issuer to send to locked holders (also during a global lock). The module adds an off-ledger issuance guard for both kinds of freeze. Direct use of the issuer key bypasses that guard. Clawback also remains available. Therefore an absolute “no movement, including redemption” freeze cannot be provided by this MPT protocol. The demo explicitly tests this exception. This implementation should not be approved for a policy requiring absolute immobilization.

```sh
npm ci
npm run build
npm test
XRPL_ISSUER_SEED='<authorized testnet seed>' npm run demo
npm run verify
```

The seed is read only from the environment and never sent to a server or written to source. The demo checks it against the supplied issuer address. New holder seeds and the transaction journal are stored in `.private/demo.sqlite` (ignored by git, restrictive file permissions). Keep this directory to resume a run or retain access to the holder accounts. `result.json` is written only after all final-state assertions pass. `verification.json` records the ledger snapshot, and `demo-transactions.json` contains public transaction evidence.

Backend use:

```ts
import { Client, Wallet } from 'xrpl';
import { Store } from './src/store.js';
import { Submitter, TESTNET, preflight } from './src/ledger.js';
import { MptIssuer, holderOptIn } from './src/issuer.js';

const client = new Client(TESTNET);
await client.connect();
await preflight(client);
const store = new Store('/secure/issuer/state.sqlite');
const signer = Wallet.fromSeed(process.env.XRPL_ISSUER_SEED!);
const submitter = new Submitter(client, store);
const issuer = await MptIssuer.create(submitter, signer, 'business-request:create');
// Or reconnect: new MptIssuer(submitter, signer, persistedIssuanceId).
// Holder must independently sign and submit holderOptIn(holderAddress, issuer.id).
// After KYC approval, using distinct persistent business request IDs:
await issuer.approve(holderAddress, 'kyc:123');
await issuer.issue(holderAddress, '1000', 'mint:123');
await issuer.clawback(holderAddress, '300', 'clawback:123');
await issuer.setHolderFreeze(holderAddress, true, 'freeze:123');
await issuer.setHolderFreeze(holderAddress, false, 'unfreeze:123');
await issuer.setGlobalFreeze(true, 'incident:123:start');
await issuer.setGlobalFreeze(false, 'incident:123:end');
await issuer.ban(holderAddress, 'ban:123');
// Graceful shutdown after outstanding work finishes:
await client.disconnect();
store.close();
```

`holderAddress` comes from your backend's approved customer record. KYC itself and access control for issuer operations are the caller's responsibility. Issuer-side operations never require holder keys. `Signer` can be implemented by a custody service or hardware signer; the demo uses a local Wallet. All amounts are positive integer **strings**, in base units, with scale 0 for this token. Values above the holder's balance claw back the entire balance, following XRPL semantics.

Ban workflow: persist a permanent policy denial, revoke on-ledger issuer authorization, claw back up to the protocol maximum, then verify zero balance and no authorization. It is a resumable sequence of validated transactions, not atomic. A pending ban already blocks this module's approval, issuance and unfreeze operations. Repeating `ban` resumes its original operation. Holders can recreate their ledger object but cannot authorize themselves. The issuer key can deliberately override policy outside this module; there is no irreversible native ban primitive. Protect issuer signing access and the policy database.

Submission uses durable SQLite commits before broadcast, local signing, a 1000-drop fee ceiling, LastLedgerSequence, network/amendment checks, and validated metadata. An operation ID is tied to the exact transaction intent. Retrying it returns the saved result or reconciles/resubmits the same signed bytes. It never automatically creates a new payment after a timeout. `tec` failures are recorded and surfaced as `LedgerFailure`; ambiguous outcomes (including early `tem`/`tef` errors from the SDK) raise `UnresolvedTransaction` with the hash, blocking new transactions for that account. Queued transactions are handled by xrpl's reliable `submitAndWait` polling. No automatic sequence replacement is attempted for `tefPAST_SEQ`.

For an unresolved/expired transaction, query the saved hash and the full ledger range through LastLedgerSequence using a server with complete history. Confirm validation or definite non-inclusion before an operator reconciles the journal and authorizes a replacement request. Never delete a pending record merely because a request timed out. This conservative path prioritizes avoiding duplicate issuance over automatic availability.

Run one issuer worker and one Submitter per issuer with this store. The exclusive store lock rejects a second process; the shared operation queue serializes policy workflows within that worker. A crash intentionally leaves a lock file: confirm the process is dead before removing only `.private/demo.sqlite.lock`. A distributed deployment needs a shared transactional store and account-level fencing. Do not run other issuer signers concurrently, and back up policy records and transaction history. SQLite data is permission-restricted but not encrypted; production key custody should use a dedicated signer and secret store.

The demo exercises unauthorized receipt rejection, holder consent/approval, transfers after unfreezing, holder locks in both directions, module issuance rejection during locks, global lock, issuer issuance and redemption exceptions, partial clawback, ban, rejected reapproval and holder deletion/recreation. It leaves A at 500 authorized/unlocked, B at 700 authorized/locked, C at zero unauthorized, and the issuance globally unlocked. A starts at 501 and C at 201 so the two demonstrated redemptions leave the requested balances. Two tokens sent directly by the issuer during locks are separately clawed back from A. It funds each holder with 5 test XRP from the issuer.

Research sources, installed versions, amendment evidence and known SDK typing limitations are documented in `research/README.md`. This is a testnet implementation with explicit operational boundaries; no independent security audit or production deployment is implied. The informational metadata intentionally makes no claim of backing or real-world redemption rights. It lacks optional discovery fields (icon and issuer branding), which the SDK warns about; ledger compliance behavior is unaffected.
