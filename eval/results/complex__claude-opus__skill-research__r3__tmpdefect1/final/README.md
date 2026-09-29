# MPT compliance issuer

Issuer-side compliance controls for a regulated, stablecoin-style
[Multi-Purpose Token](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
on the XRP Ledger. TypeScript (strict), `xrpl` 5.3.0, currently targeting testnet.

```sh
npm install
cp .env.example .env   # set ISSUER_SEED
npm test               # unit tests
npm run typecheck
npm run demo           # full testnet demo; writes result.json
npm run verify         # re-checks the ledger state described by result.json
```

## Using the module

```ts
import { Client } from 'xrpl'
import { FileBanList, loadConfig, MptIssuer } from './src/index.js'

const { wsUrl, issuerWallet, banListPath } = loadConfig()
const client = new Client(wsUrl)
await client.connect()
const issuer = await MptIssuer.load(client, issuerWallet, ISSUANCE_ID, {
  banList: new FileBanList(banListPath),       // swap for a DB-backed BanList
  onAudit: (event) => auditLog.write(event),   // awaited after every action
})

await issuer.authorizeHolder(address)           // allowlist (holder must opt in first)
await issuer.issue(address, '500')
await issuer.clawback(address, '300', reason)   // or 'all'
await issuer.freezeHolder(address, reason)      // / unfreezeHolder
await issuer.freezeAll(reason)                  // / unfreezeAll
await issuer.banHolder(address, reason)
```

Amounts are decimal strings in display units, converted with the issuance's
`AssetScale`. Policy refusals throw `ComplianceViolationError` (nothing is
submitted); ledger failures throw `XrplTransactionError` with the result code
and hash. Every action checks the ledger afterwards and throws
`PostConditionError` if the ledger doesn't show the expected result.
Freeze, unfreeze and authorize are idempotent, and `banHolder` can be re-run to
finish a ban that failed part-way. Calls on one instance run one at a time;
run a single instance per issuing key.

## How each control maps to the ledger

The issuance is created with **Can Lock**, **Require Auth**, **Can Clawback**
and (by default) **Can Transfer**. `MptIssuer.load` refuses issuances that lack
the first three. It also refuses issuances with **Can Escrow**, **Can Trade** or
confidential balances, because those let holders move tokens into escrows, AMM
pools or encrypted balances that a plain clawback can't reach. The
`DynamicMPT` amendment is not enabled on testnet (checked 2026-09-28), so
capabilities can't be added after creation.

| Control | Implementation |
|---|---|
| Allowlist | Require Auth; `MPTokenAuthorize` with `Holder` after the holder opts in |
| Clawback | `Clawback` with `Holder`; `'all'` requests 2^63−1, which the ledger caps at the full balance |
| Per-holder freeze | `MPTokenIssuanceSet` + `Holder` + `tfMPTLock` / `tfMPTUnlock` |
| Global freeze | `MPTokenIssuanceSet` + `tfMPTLock` / `tfMPTUnlock` |
| Ban | durable ban-list entry → revoke authorization → lock → claw back everything → verify |

## Protocol behaviour the compliance team should know

Probed on testnet (rippled 3.4.1) on 2026-09-28:

- **The ledger lets the issuer pay a frozen holder**, even under a global
  freeze. `issue()` refuses these payments itself, so the "frozen holders can't
  receive" rule depends on all issuance going through this module.
- **A frozen holder can still send tokens back to the issuer** (per-holder or
  global freeze). This is the protocol's redemption path and can't be disabled.
  Holder-to-holder transfers in either direction fail with `tecLOCKED`.
- **Revoking authorization doesn't remove a balance.** The tokens stay put but
  can't move (`tecNO_AUTH`, even to the issuer). That's why `banHolder` claws
  back and `revokeAuthorization` refuses holders with a balance.
- **A banned holder can delete its emptied `MPToken` and opt in again**, but the
  new entry isn't authorized, so it still can't receive (`tecNO_AUTH`). The
  durable ban list makes sure the module never re-authorizes it. Deleting a
  locked `MPToken` is blocked only once `fixCleanup3_4_0` is enabled.
- The ledger omits `MPTAmount` when a balance is zero.
