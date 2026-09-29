# MPT compliance issuer

Issuer-side controls for a regulated, stablecoin-style Multi-Purpose Token (MPT) on the XRP Ledger, in TypeScript on `xrpl` 5.3.0.

```sh
npm install
cp .env.example .env   # set ISSUER_SEED
npm test               # unit tests
npm run demo           # full demo against testnet; writes result.json
npm run build          # compiles src/ to dist/
```

## Using the module

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer } from './src/index.js';

const issuer = await MptIssuer.load(client, Wallet.fromSeed(seed), issuanceId, {
  banRegistry, // durable ban list, backed by your database (see BanRegistry)
  audit: (event) => auditLog.write(event), // compliance audit trail
});

await issuer.authorizeHolder(address);      // allowlist, after KYC (holder must opt in first)
await issuer.issue(address, '500');         // amounts are decimal strings in token units
await issuer.clawback(address, '300');      // or 'all'
await issuer.freezeHolder(address);         // / unfreezeHolder
await issuer.freezeAll();                   // / unfreezeAll
await issuer.banHolder(address, 'reason');  // record ban, unauthorize, claw back all, freeze
```

`MptIssuer.createIssuance(...)` creates a new issuance with every control enabled. `load` refuses any issuance that lacks a required control.

State-changing calls wait for validation. They throw `ComplianceError` when the module refuses (nothing is submitted), `TransactionFailedError` when the ledger rejects, and `TransactionOutcomeUnknownError` when the outcome is unknown. In the last case, look up the hash before retrying. Controls are idempotent, so repeating one that has already taken effect is a no-op.

## How each control is enforced

The issuance is created with **Require Auth**, **Can Lock** and **Can Clawback**, plus **Can Transfer** so approved holders can pay each other. The `DynamicMPT` amendment is not enabled on testnet or mainnet, so these flags are permanent. **Can Escrow** and **Can Trade** are deliberately left off, because escrowed and AMM-held balances cannot be reached by `Clawback`.

| Control | Ledger enforcement | Module enforcement |
|---|---|---|
| Allowlist | Payments to or from an unapproved holder fail with `tecNO_AUTH` | `authorizeHolder` refuses banned addresses |
| Clawback | Works regardless of freezes or authorization; clawing back more than the balance takes the whole balance | Returns the exact amount clawed back |
| Per-holder freeze | Holder-to-holder payments involving the holder fail with `tecLOCKED` | `issue` refuses, because the ledger still allows issuer → frozen holder |
| Global freeze | All holder-to-holder payments fail with `tecLOCKED` | `issue` refuses, for the same reason |
| Ban | Unauthorized: the holder can neither send nor receive | Ban recorded first; the holder is never re-authorized |

Things the compliance team should know:

- **Redemption while frozen.** A frozen holder, or any holder during a global freeze, can still send tokens back to the issuer. The ledger always allows this, and it can only reduce their balance.
- **What enforces a ban.** A ban is enforced by revoking authorization, backed by the `BanRegistry`. The per-holder freeze is extra protection only: until the `fixCleanup3_4_0` amendment is enabled, a frozen holder with a zero balance can delete their MPToken entry. Re-creating it leaves them unauthorized, so they still cannot receive the token.
- **Asset scale.** AssetScale is permanent. The demo uses 0 (whole tokens); choose the production scale before issuing on mainnet.
