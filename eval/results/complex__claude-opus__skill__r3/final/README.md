# Regulated MPT issuer

Issuer-side compliance controls for a stablecoin-style Multi-Purpose Token (MPT) on the XRP Ledger, in TypeScript on `xrpl` (xrpl.js 5.x). Targets testnet.

## Usage

```ts
import { Client, Wallet } from 'xrpl';
import { MptIssuer, JsonFileBanStore } from './src/index.js';

const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const issuer = await MptIssuer.load(client, Wallet.fromSeed(seed), issuanceId, {
  banStore: new JsonFileBanStore('.data/bans.json'), // use a DB-backed BanStore in production
});

await issuer.authorizeHolder(addr);         // allowlist (after KYC; holder must have opted in)
await issuer.issue(addr, '100.25');         // amounts are decimal strings, never floats
await issuer.clawback(addr, '40');
await issuer.freezeHolder(addr);  await issuer.unfreezeHolder(addr);
await issuer.freezeAll();         await issuer.unfreezeAll();
await issuer.banHolder(addr, 'reason for audit trail');
await issuer.getHolderState(addr);  await issuer.getIssuanceState();
```

`MptIssuer.createIssuance(client, wallet, policy, opts)` creates a new issuance. It always sets RequireAuth, CanLock and CanClawback and never sets CanEscrow. `load()` refuses any issuance that doesn't meet those rules. Capability flags can only be set at creation time, because the `DynamicMPT` amendment is not enabled.

## How each control maps to the ledger

| Control | Mechanism | Enforced by |
|---|---|---|
| Allowlist | `tfMPTRequireAuth`, issuer `MPTokenAuthorize` | Ledger (`tecNO_AUTH`) |
| Clawback | `tfMPTCanClawback`, `Clawback` with `Holder` | Ledger; works while frozen or de-authorized |
| Per-holder freeze | `MPTokenIssuanceSet` + `Holder` + `tfMPTLock`/`tfMPTUnlock` | Ledger for holder transfers (`tecLOCKED`); **module only** for issuer payments |
| Global freeze | `MPTokenIssuanceSet` + `tfMPTLock`/`tfMPTUnlock` | Ledger for holder transfers (`tecLOCKED`); **module only** for issuer payments |
| Ban | Record in `BanStore` → freeze → claw back full balance → de-authorize → verify | Ledger (`tecNO_AUTH`) plus `BanStore` to block re-approval |

## Important caveats for compliance

- **Freezes do not stop the issuer's own payments.** This was verified on testnet (rippled 3.4.1). The ledger accepts a payment from the issuer to a frozen holder, or during a global freeze. `issue()` refuses both cases, so issue tokens only through this module, and restrict access to the issuer key accordingly. Bans don't have this gap: they de-authorize the holder, so the ledger rejects even issuer payments.
- **Bans are durable only through the `BanStore`.** On-ledger, a banned holder is left de-authorized, frozen and at zero balance. The holder can delete that empty entry, though. After that, only the ban store stops an operator from re-approving the address. Back the store with your compliance database.
- `banHolder` is idempotent. If it's interrupted, running it again finishes the remaining steps. The ban is recorded before any transaction is sent, so the module fails closed.
- Run **one `MptIssuer` instance per issuer key**. Operations are serialized within an instance, but separate processes would compete for sequence numbers and could interleave the steps of a ban.
- Every transaction is signed locally and only counts as done once it is **validated with `tesSUCCESS`**. A `TransactionOutcomeUnknownError` means the result is uncertain. Look up its `hash` before retrying.
- MPTokenMetadata is public. Never put personal data in it.

## Demo

```sh
npm install
cp .env.example .env              # fill in XRPL_ISSUER_SEED / XRPL_ISSUER_ADDRESS
npm run demo -- --rehearsal       # full run with a throwaway issuer funded from your account
npm run demo                      # real run: your account issues; writes result.json
npm test && npm run typecheck
```

The demo exercises every control, including ledger-level rejections, and asserts the final state before it writes `result.json`. It saves the generated holder seeds to `demo-wallets.json`, which is gitignored and testnet only. The demo uses `AssetScale: 0`, so "500 tokens" is the raw on-ledger amount `500`.
