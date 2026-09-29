# Regulated MPT issuer (XRPL testnet)

TypeScript in strict mode, using pinned `xrpl@5.3.0`. `src/issuer.ts` provides the backend API; `src/demo.ts` runs the live, resumable compliance demonstration. All amounts are **integer strings**, with asset scale **0** and zero transfer fees.

**Protocol boundary:** native MPT locks stop transfers between holders, but permit redemption to the issuer. The issuer can also bypass locks in direct payments on the MPT V1 payment path. The module blocks minting while a holder or the issuance is frozen, but cannot stop holder-signed redemptions. Therefore a literal guarantee of “no sending/receiving whatsoever” or “no movement whatsoever” is not achievable with these MPT lock controls. The live demo tests the redemption exceptions and restores A's balance afterward. Administrative clawback remains available while locked.

The issuance enables `CanLock | RequireAuth | CanTransfer | CanClawback` (102 / `0x66`). Trading, escrow, confidential balances, and permissioned-domain authorization are not enabled. Those features would add authorization or custody paths requiring a separate review. The module checks this configuration before issuer mutations.

## Run

```sh
npm ci
npm run build
npm test
export XRPL_ISSUER_SEED='your testnet seed'
export XRPL_ISSUER_ADDRESS='rp6RHAeLoaj98n9QSHDCr3eAvWLPhEedDX'
npm run demo
npm run verify
```

`npm run verify` is read-only and needs no issuer seed. The demo checks the provided seed against the expected issuer address and checks `server_info.network_id === 1` before signing. It funds three generated holders with 5 test XRP each from the issuer. It never prints seeds or writes the issuer seed to disk. Holder seeds and the durable journal are stored in gitignored `.local/demo-state.json`, with owner-only file permissions. Preserve this file to resume the same issuance; deleting it starts a new demo and creates new accounts and a new issuance.

Outputs:

- `result.json`: exactly the requested issuance ID and three classic addresses, published only after final verification succeeds.
- `demo-evidence.json`: transaction hashes, validated results, and a final snapshot from one validated ledger hash.
- `.local/demo-state.json`: private recovery data, operation checkpoints, and permanent ban policy. Do not publish this file; it includes holder seeds and signed transaction blobs.

Final assertions: issuer matches the supplied account; flags equal 102; outstanding supply is 1,200; A is authorized with 500 and unlocked; B is authorized with 700 and locked; C has zero and lacks authorization; global lock is off. C deliberately deletes and recreates its holding during the adversarial ban test. Its new holding is unlocked but **still unauthorized**, and both issuer-to-C and A-to-C payments fail. A holder cannot restore issuer authorization by opting in again.

The demo includes failed payment transactions on purpose. `tecNO_AUTH` and `tecLOCKED` must appear in **validated metadata**, not just a preliminary submission response. Those failures consume small XRP fees but move no tokens. It also tests successful transfers after unlocking and rejects issuer API reapproval, unfreezing, and minting for a banned holder.

## Backend API

```ts
import { Client, Wallet } from 'xrpl';
import { FileStore, LedgerExecutor, MptIssuer, TESTNET_URL } from './src/index.js';

const client = new Client(TESTNET_URL, { maxFeeXRP: '0.001' });
const store = await FileStore.open('/your/private/issuer-state.json');
try {
  await client.connect();
  const ledger = new LedgerExecutor(client, store);
  await ledger.checkNetwork();
  await ledger.reconcilePending();
  const signer = Wallet.fromSeed(process.env.XRPL_ISSUER_SEED!);
  const issuer = new MptIssuer(ledger, signer, existingIssuanceId);
  await issuer.validateConfiguration();
  // For a NEW asset: await MptIssuer.create(ledger, signer, uniqueCreationId)

  await issuer.approve(holderAddress, 'kyc-approved-case-123');
  await issuer.mint(holderAddress, '1000', 'mint-order-456');
  await issuer.clawback(holderAddress, '300', 'recovery-case-789');
  await issuer.freezeHolder(holderAddress, true, 'freeze-case-101');
  await issuer.freezeHolder(holderAddress, false, 'unfreeze-case-102');
  await issuer.freezeGlobal(true, 'incident-103-freeze');
  await issuer.freezeGlobal(false, 'incident-103-resolved');
  await issuer.ban(holderAddress, 'compliance-case-104', 'ban-case-104');
} finally {
  await client.disconnect();
  await store.close();
}
```

The snippets' address/ID variables come from your backend. KYC itself is performed by that backend: call `approve` only after its compliance decision. Holders opt in with their own signed `MPTokenAuthorize` transaction; the demo shows this separately. The issuer module never requires holder keys.

`Signer` is an injected interface, so a custody/HSM adapter can replace `Wallet`. The executor compares the signed payload to the prepared transaction, checks its hash, persists signed bytes before broadcast, enforces a 1,000-drop fee ceiling and bounded `LastLedgerSequence`, and accepts only validated metadata. `requireSuccess()` raises `TransactionFailed` for a validated failure. `clawback` follows native semantics: an amount exceeding the holder's balance claws back the entire available balance; a zero-balance holder yields a ledger error. There is no floating-point conversion or accidental XRP clawback path.

Use one `LedgerExecutor` and one exclusively held `Store` for all callers using an issuer. Operations queue within the process, including complete ban workflows. Do not run an independent signer or another process against the same issuer sequence or mutate the issuance outside this service. `FileStore` enforces a lifetime exclusive lock and atomically replaces/fsyncs its journal. For multiple service instances, provide durable shared storage **and an exclusive distributed issuer lease**; the `Store` interface alone does not provide that lease. Back up the ban records and transaction journal together. Access to issuer keys can override authorization and locks outside this module, so permanent bans also depend on signing governance.

## Bans and recovery

A ban is a multi-transaction workflow, not an atomic ledger primitive:

1. Persist a pending ban and its case reference. Pending bans already deny API approval, unfreezing, and minting.
2. Revoke holder authorization and wait for validation. This blocks inbound payments, including direct issuance, and does not depend on the holder keeping its `MPToken` entry.
3. Lock the holding, then claw back the maximum representable MPT amount to drain it fully.
4. Read validated state and mark complete only when the balance is zero and authorization is absent.

A ban of a holder with no holding still creates the permanent backend deny record. With `RequireAuth`, subsequent opt-in grants no authorization. No automatic unban operation is exposed. Ban intent is durable across service restarts. Resume an incomplete ban with its original ID and case reference; do not report it as completed merely because one transaction succeeded. Funds moved before revocation validates cannot be retroactively recovered from that address; further tracing and holder actions require separate compliance decisions.

Use globally unique, stable operation IDs. Retry a financial operation with the **same ID and payload**; replay returns its stored validated receipt and never sends a second payment. A changed payload under an existing ID is rejected. Historic state-setting operations can fail their current postcondition after later operations supersede them; the demo checkpoints finished steps so restarting it does not reapply historic freezes.

On a network failure, `OutcomeUnknown` includes the transaction hash. The executor blocks new mutations while the outcome is unresolved. At startup, call `reconcilePending()`; it queries that hash and, if needed, submits exactly the original signed bytes. It never signs a replacement automatically. If the expiry has passed and the server cannot establish inclusion, leave the operation blocked and reconcile using a trusted server with complete transaction history for the submission/expiry interval. Only an operator who proves non-inclusion should archive that unresolved record and authorize a replacement operation. Never treat a timeout or one `txnNotFound` response as proof of failure.

After an ungraceful process exit, `.local/demo-state.json.lock` may remain. Confirm that the old process is dead and no other issuer worker is active before removing only the lock file. Keep the state file intact and reconcile the pending transaction before resuming. Losing or rolling back the journal can lose bans and payment deduplication guarantees.

The demo's initial descriptive metadata is deliberately test-only and does not supply a hosted icon or full XLS-89 discovery metadata; `xrpl` emits an advisory warning. This does not affect ledger compliance flags or the verified balances.

## References

- [MPT compliance controls and redemption exception](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
- [Issuance flags](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate)
- [Holder authorization and revocation](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
- [Individual and global locking](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset)
- [MPT clawback and amount semantics](https://xrpl.org/docs/references/protocol/transactions/types/clawback)
- [Payment implementation, including issuer lock exemptions](https://github.com/XRPLF/rippled/blob/develop/src/libxrpl/tx/transactors/payment/Payment.cpp)

The automated tests cover exact integer amounts, ban ordering and crash recovery, permanent policy after restart, zero/absent holdings, failed postconditions, mint restrictions, transaction deduplication, changed-payload rejection, ambiguous outcomes, failed durable writes, signer payload changes, validated failures, and the testnet guard. Testnet reset or future amendments can change observable behavior, so rerun the live verification and compliance tests against the network version you deploy to. This integration is not an independent security audit or a determination of regulatory compliance.
