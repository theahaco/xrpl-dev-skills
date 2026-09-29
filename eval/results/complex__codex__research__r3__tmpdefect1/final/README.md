# Regulated MPT issuer — XRPL testnet

Reusable strict TypeScript issuer module and a restartable, live testnet demo. See [research and protocol decisions](docs/RESEARCH.md), [result](result.json), and [validated ledger evidence](verification.json).

```sh
npm ci
npm run check
npm test
npm run build
# Supply the testnet issuer seed through your secret manager/environment:
npm run demo
npm run verify  # read-only, does not require the seed
```

The demo reads `ISSUER_SEED` and verifies the supplied issuer address. It funds three new wallets with 10 test XRP each. It stores their seeds in ignored `.private/demo.json` with mode 0600; it never writes the issuer seed. Preserve this directory for restart, idempotency, and permanent ban policy. A completed rerun verifies the existing issuance rather than creating another.

## Backend use

```ts
import { Wallet } from 'xrpl';
import { Runtime } from './src/runtime.js';
import { MptIssuer } from './src/issuer.js';

const runtime = await Runtime.open('/secure/persistent/issuer-state');
try {
  const signer = Wallet.fromSeed(process.env.ISSUER_SEED!);
  const token = await MptIssuer.attach(runtime, signer, issuanceId);
  // Holder signs token.optInTransaction(holder) with their own wallet first.
  await token.approve(holder, 'kyc-case-123/approve');
  await token.issue(holder, '500', 'deposit-456/issue');
  await token.setHolderFreeze(holder, true, 'case-789/freeze');
  await token.clawback(holder, '100', 'case-790/clawback');
  await token.ban(holder, 'compliance-case-791', 'case-791/ban');
  await token.setGlobalFreeze(true, 'incident-12/freeze');
} finally {
  await runtime.close();
}
```

`create(runtime, signer, stableOperationId)` creates an issuance and enables issuer DepositAuth. `Signer` is an interface, so signing can be delegated to a controlled signing service. Holder keys are required only by the demo; backend approval, freeze, clawback and ban use only the issuer signer. KYC verification happens upstream; `approve` records the already approved decision on ledger. Amounts are positive integer strings, never floating-point values. Clawback is capped by the actual available balance per XRPL rules.

## Compliance behavior

- RequireAuth enforces the allowlist on ledger. Holder opt-in alone cannot authorize receipt.
- Individual/global locks block holder-to-holder MPT payments; DepositAuth with **no preauthorizations** closes the native return-to-issuer exception. **Live testnet also permits the issuer to pay a locked holder.** The module's `issue` method checks individual/global locks before signing to close this issuer-side exception. DepositAuth stays enabled even when unfrozen and affects all incoming payments to this issuer. Do not add deposit preauthorizations. A separate redemption workflow can use controlled clawbacks.
- Ban persists a deny record before ledger operations, locks, revokes approval, drains and verifies. Deleting/recreating an empty holding does not restore authorization. There is deliberately no unban API; banned addresses cannot be approved, issued to, or unfrozen through this module.
- Global unlock does not clear individual locks. Administrative clawback remains available during freezes.
- Ban cannot be atomic on this network. Until the workflow finishes, treat it as pending and retry the same operation. Completion means the ledger postconditions were verified.

## Reliability and deployment boundary

Every submission has a caller-supplied stable operation ID. Signed bytes and hash are fsynced before broadcast; validated receipts are saved before success is returned. Reusing an ID for another intent is rejected. Do not reuse IDs for a new action or change IDs to retry an uncertain payment. Ambiguous outcomes block further submissions. On restart the runtime reconciles the saved hash or resubmits identical bytes, never automatically signs a replacement transaction.

An expired transaction absent from available server history requires operator reconciliation against full ledger history before any replacement. Preserve the journal; do not delete it to clear an error. Validated failed transactions retain their receipt and cannot become successful on retry under the same ID.

Use one persistent directory and one exclusive signer worker per issuer. `writer.lock` prevents concurrent processes using that directory; workflows serialize in-process. All raw `Runtime.send` calls must be inside `Runtime.run`. Do not nest `run` or run a second worker against another directory for the same issuer. After a hard crash, confirm the old worker is dead before removing the stale `.private/writer.lock` directory; restart reconciles pending signed bytes. The supplied file adapter is for one host with a durable filesystem. Multi-host deployment needs a shared transactional journal, distributed issuer lock, and protected signing service.

Issuer keys must be exclusive to this service. Out-of-band transactions can bypass local bans, pay a frozen holder, or alter DepositAuth; configuration checks detect drift but cannot stop another signer. Thus the strict freeze guarantee combines ledger enforcement and issuer signing policy; MPT locks alone do not provide the literal guarantee against issuer-originated payments. Secure and back up policy/journal state with the keys. There is no claim that this testnet implementation establishes regulatory compliance or has undergone independent security audit.

The demo validates rejected unapproved receipts; individual send/receive/issuance/redemption freezes; transfers after unfreezing; global freeze and recovery; partial clawback; ban; reapproval prevention; and deleted/recreated holding attacks. Final balances and flags are read from one validated ledger hash. `verification.json` records that snapshot; `transactions.json` records public transaction hashes and outcomes. Testnet can reset.
