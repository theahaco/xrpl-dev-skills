# Regulated MPT issuer (XRPL testnet)

Strict TypeScript backend module using `xrpl`. Native MPT controls are implemented per issuance; this does not use trust-line AccountSet flags. The live demo uses issuer `rDXCSJkxZtZobieHcCzZeeRJw4TG4KxqfE` and three newly generated holders.

**Compliance boundary:** native MPT locks block transfers between holders and incoming issuance, but still allow direct redemption to the issuer. Clawback also remains possible. Therefore neither individual nor global freeze can satisfy an absolute “no movement” requirement. A backend cannot prevent a holder submitting a redemption directly. This implementation is a testnet integration, not an audited production deployment or proof of regulatory compliance.

## Run

Requires Node.js 22+.

```sh
npm ci
npm run build
npm test
# Set ISSUER_SEED through your secret manager/environment, then:
npm run demo
```

The issuer seed is never saved by the demo. Generated holder seeds and transaction journals are stored under ignored `.private/` (directory 0700, files 0600). Keep that directory to resume the same demonstration. Never commit or publish it. `result.json` contains the requested issuance ID and addresses; `audit.json` contains public step receipts and transaction hashes; `verification.json` contains the final entries read at one validated ledger hash. The demo refuses concurrent execution using `.private/demo.lock`. After a process crash, confirm it is no longer running before removing a stale lock.

The demo funds each holder with 5 test XRP from the issuer. Each holder opts in, is denied receipt before approval, and then receives issuer authorization. A receives 500; its send/receive attempts while frozen fail and transfers succeed after unfreezing. B receives 1,000, loses 300 to clawback, and is left frozen. C receives 200, is banned, and cannot receive even after deleting/recreating its holding entry. The demo tests global freezing, restores movement, and verifies all balances, flags, issuer ownership, and outstanding supply at the same validated ledger.

## Backend use

```ts
import { Client, Wallet } from 'xrpl';
import { FileStore, MptIssuer, Transactions } from './src/index.js';

const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const signer = Wallet.fromSeed(process.env.ISSUER_SEED!);
const store = new FileStore('/secure/issuer-state');
const transactions = new Transactions(client, store);
const issuer = await MptIssuer.create(transactions, signer, store, 'business-request-create-1');
// Or attach to an existing issuance:
// const issuer = new MptIssuer(transactions, signer, issuanceId, store);
await issuer.assertCapabilities();
// Holder must first submit its own MPTokenAuthorize (without Holder).
await issuer.approve('kyc-decision-123', holderAddress);
await issuer.mint('issuance-request-123', holderAddress, '500');
await issuer.freeze('freeze-case-123', holderAddress, true);
await issuer.freeze('release-case-123', holderAddress, false);
await issuer.clawback('recovery-case-123', holderAddress, '300');
await issuer.globalFreeze('incident-123', true);
await issuer.globalFreeze('incident-resolved-123', false);
await issuer.ban('ban-case-123', holderAddress);
await client.disconnect();
```

Every mutation requires a unique, stable business operation ID. Retry with the **same ID and arguments**. All amounts are positive canonical integer strings in base units; no floating-point conversion. AssetScale is 0 for this demo, supply cap is 1 billion, transfer fee is zero, and escrow, trading and confidential balances are disabled. Clawback takes up to the requested quantity, capped by the actual holder balance. It cannot recover already-spent balances from that holder.

`approve` records ledger authorization; the backend must perform KYC and authorize the caller before invoking it. Holder opt-in alone cannot grant issuer authorization. No permissioned domain is configured, so credentials cannot bypass explicit authorization.

`ban` durably records the policy ban, revokes ledger authorization, then claws back the entire available balance with the maximum allowed amount. It verifies zero balance and revoked authorization before returning. This is a resumable multi-transaction workflow, not atomic; until revocation validates, the holder can transact. If interrupted, keep the case pending and retry the same operation ID. The persistent policy prevents subsequent approval, minting, or unfreezing through this module. A holder may recreate a zero-balance entry, but it is still unauthorized. The ledger has no permanent ban bit: anyone controlling the issuer signing authority can reauthorize outside this module. Preserve and protect the ban database.

## Transaction and operational guarantees

- Mutations on one module instance are serialized, including the full ban workflow. Transaction submission is also serialized to avoid sequence collisions. Use a single module/runner per issuer and an **exclusive distributed lock covering whole business operations** across workers, instances, and other issuer software. The file adapter is single-writer only.
- Signing is local; the reusable `Signer` interface also accepts an asynchronous signing adapter. For production use an approved custody/HSM signer, access controls, and auditable compliance decision IDs.
- Signed transactions are persisted before broadcast. A successful return requires validated `tesSUCCESS`; validated failures throw `LedgerFailure` with the receipt and remain journaled. Unknown outcomes throw `UncertainSubmission` with the hash. Retrying reconciles by hash or resubmits the exact signed blob. `terQUEUED` is handled by the SDK's validation wait. Transactions are never automatically rebuilt with a new sequence after `tefPAST_SEQ`, expiry, or transport failures, because that risks duplicate minting. An operator must reconcile those hashes against full ledger history before authorizing a replacement business operation.
- Fees are autofilled but capped at 1,000 drops (0.001 XRP), and a LastLedgerSequence expiry is mandatory. Submission verifies testnet network ID 1. It will not send on mainnet. Connecting to a trusted testnet endpoint is still the caller's responsibility.
- Reserve amounts are queried from the server; at execution they were 1 XRP base and 0.2 XRP per owner object. Funding, the issuance object and holder objects consume XRP/reserves. Reserve requirements can change.
- `Store` implementations must provide durable read-after-write persistence and fail closed on storage errors. For deployment, replace local files with transactional durable storage under the same issuer lock, encrypted backups and retention controls. Loss of journal data loses duplicate protection; loss of ban data loses the backend reapproval guard.
- Operations check issuance ownership and required capabilities before signing. Compliance semantics and amendment behavior must be revalidated before any deployment to another network. Neither the code nor the demo prevents issuer-key compromise.

## Protocol references

- [MPT compliance controls and redemption exception](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset)
- [Clawback: MPT Holder field and amount semantics](https://xrpl.org/docs/references/protocol/transactions/types/clawback)

The included ten unit tests cover validation, serialization, ban sequencing/recovery, durable deduplication, uncertain submission recovery, and validated failures. `npm run demo` is the funded integration test and deliberately incurs fees for negative tests. The token's descriptive metadata is simple JSON rather than an XLS-89 wallet-display profile; ledger compliance controls do not depend on that metadata.
