# XRPL MPT issuer (testnet)

Strict TypeScript backend library using `xrpl`. The issuance enables RequireAuth,
CanLock, CanClawback and CanTransfer. Escrow, DEX trading, confidential balances,
permissioned-domain authorization and transfer fees are excluded from this profile.
Amounts are integer strings in base units. This demo uses AssetScale 0: `"500"`
means 500 tokens. This is a test token, with no claim of financial backing.

**Protocol limitation:** MPT freezes are native locks, not an absolute halt.
Locked holders can still redeem/burn tokens by paying the issuer; issuer clawback
also remains available. Global locking has the same redemption exception. This
implementation therefore cannot meet a literal requirement that *all* movement,
including redemption, stop. Do not represent these controls to compliance as an
absolute freeze. See the official [MPT compliance controls](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls).

## Run

Use Node.js 22 or newer:

```sh
npm ci
npm run build
npm test
# Supply the testnet issuer seed through your secret manager/environment:
export ISSUER_SEED='<testnet seed>'
npm run demo
npm run verify
```

The demo requires the specified issuer address, checks network ID 1, creates three
wallets and funds each with 5 XRP from the issuer. Live testnet reserves at execution
were 1 XRP base and 0.2 XRP per object. Reserve settings are read from the server;
funding and transaction fees consume test XRP. Signing is local. The issuer seed is
never written to the project or sent to an RPC server.

`result.json` contains the requested issuance ID and holder addresses.
`verification.json` records the final ledger index/hash and entries, read at one
validated ledger. `audit.json` contains transaction receipts and hashes, including
the negative compliance tests. `npm run verify` rechecks the current validated
state without signing or needing seeds.

The demo resumes using `.private/demo-state.json`, a mode-0600 journal containing
holder seeds, signed transactions, step checkpoints and ban records. Keep this
file secret and backed up; it is gitignored. Re-running the completed demo verifies
the same issuance, rather than issuing another token. Do not delete the journal
to retry. A process lock prevents concurrent demos. After an unclean process exit,
confirm the old process is dead before removing `.private/demo.lock`.

## Backend integration

```ts
import { Client, Wallet } from 'xrpl';
import { FileStore, Transactions, MptIssuer, TESTNET } from './src/index.js';

const client = new Client(TESTNET);
await client.connect();
try {
  const wallet = Wallet.fromSeed(process.env.ISSUER_SEED!);
  // Hold an exclusive worker/process lease for this issuer and this store.
  const store = new FileStore('.private/backend.json');
  const transactions = new Transactions(client, store);
  const token = await MptIssuer.attach(transactions, wallet, issuanceId);
  // Holder must first sign MPTokenAuthorize (without Holder) to opt in.
  // Invoke approval only after your backend has verified KYC and operator rights.
  await token.approve(holderAddress, 'kyc-case-123:approve');
  await token.mint(holderAddress, '500', 'deposit-456:mint');
  await token.clawback(holderAddress, '100', 'case-789:clawback');
  await token.setHolderFrozen(holderAddress, true, 'case-790:freeze');
  await token.setHolderFrozen(holderAddress, false, 'case-791:unfreeze');
  await token.setGlobalFrozen(true, 'incident-123:freeze');
  await token.setGlobalFrozen(false, 'incident-123:unfreeze');
  await token.ban(holderAddress, 'case-999:ban');
} finally {
  await client.disconnect();
}
```

Use `MptIssuer.create(transactions, wallet, operationId, maximumAmount)` to create
an issuance. The default maximum outstanding supply is one billion base units.
`attach` checks issuer identity and the supported capability profile. Approval is
an explicit backend assertion that KYC has passed; this library does not perform
identity verification or authenticate your application's operators.

Clawback accepts positive amounts up to 2^63−1. The ledger clamps a request above
the holder's balance to the available balance. Zero/negative/fractional amounts
are rejected. See [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback).

## Ban guarantees and recovery

A ban persists intent first, revokes issuer authorization, locks the holding, then
claws back its entire remaining balance. Each transaction must validate before
the next step. Completion requires a zero balance and no authorization. Until
completion it is a **pending ban**, not an atomic ledger action. Retry the same
operation ID after an interruption. The address remains locally blocked from
approval, minting and unlocking even while a ban is pending.

Revocation is the on-ledger receipt barrier. Removing and recreating a holding
cannot restore issuer authorization. The demo tests this explicitly. A holder who
has no holding can also be banned: future opt-in creates an unauthorized holding.
The immutable ban policy is in the backend store; XRPL does not have a permanent
address-ban flag. Another service using the issuer's signing key can override
authorization, so every issuer-key operation must follow the same policy.

The multi-transaction ban cannot recover tokens a holder transferred away before
revocation validated. Escrow/trading/confidential features are disabled to keep
balances directly recoverable within this profile.

## Transaction reliability and deployment boundaries

Transactions are signed only after autofill supplies sequence, fee and a bounded
LastLedgerSequence. Fees above 1000 drops are refused. The signed blob/hash is
durably stored before submission. A successful submission is not treated as a
successful operation: only validated `tesSUCCESS` qualifies. Validated `tec`
failures are recorded and surfaced as `LedgerFailure`, never silently retried.

Reuse the same operation ID for the same transaction after a transport failure.
The journal queries the original hash, then resubmits the same signed blob if
needed. The SDK waits through queued outcomes. Ambiguous outcomes block later
operations from that account. Expired or past-sequence outcomes without a known
validated hash require operator reconciliation using the journal hash, expiry,
and complete ledger history. The implementation deliberately does not sign a new
payment on an uncertain outcome. A new business attempt requires a new operation
ID after the original has been conclusively reconciled.
`transactions.resumePending(wallet)` queries/replays the original signed operation
without constructing a new one; ban retries perform this reconciliation before
examining a potentially changed holder balance.

The included file adapter supports **one process/worker per issuer**, with one
shared Transactions and MptIssuer instance. A production distributed deployment
must supply a transactional database-backed Store and issuer-wide lease spanning
entire operations, including multi-transaction bans. Keep all issuances sharing an
issuer in the same sequence coordinator. Protect journal access, backups and the
signing key; integrate your organization's signing custody, KYC, approval and
audit-retention systems before using real assets. This testnet implementation is
not an independent security audit or a regulatory certification.

## Files and validation

- `src/issuer.ts`: typed issuer controls, validation, resumable bans and ledger reads.
- `src/transactions.ts`: serialized, journaled signing and validated receipts.
- `src/store.ts`: persistent single-process store and replaceable Store interface.
- `src/demo.ts`: resumable testnet scenario with successful and rejected transfers.
- `src/verify.ts`: independent, read-only final state verification.
- `test/issuer.test.ts`: precision, real serialization, idempotency, uncertain
  outcomes, validated failures and interrupted-ban recovery tests.

Native transaction references: [authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize),
[locking](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset).
