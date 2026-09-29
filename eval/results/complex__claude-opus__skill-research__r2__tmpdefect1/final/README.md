# MPT compliance issuer

Issuer-side controls for a regulated, stablecoin-style Multi-Purpose Token (MPT) on the XRP Ledger.
Written in TypeScript (strict), using `xrpl` 5.3.0. Currently targets testnet.

## Usage

```ts
import { Client, ECDSA, Wallet } from 'xrpl'
import { JsonFileBanRegistry, MptIssuer } from './dist/index.js'

const client = new Client('wss://s.altnet.rippletest.net:51233')
await client.connect()
const deps = {
  client,
  issuerWallet: Wallet.fromSeed(process.env.ISSUER_SEED!, { algorithm: ECDSA.ed25519 }),
  banRegistry: new JsonFileBanRegistry('data/bans.json'), // back this with your compliance DB in production
  expectedNetworkId: 1, // refuse to act on any other network
}

const mpt = await MptIssuer.load(deps, '014279910EAE7BF62D79DDB80C8F44CC63682242595B5C5E')
await mpt.authorizeHolder(addr)        // allowlist (holder must first opt in with MPTokenAuthorize)
await mpt.issue(addr, '100')           // amounts are display units at the token's AssetScale
await mpt.clawback(addr, '25')         // or 'all'
await mpt.freezeHolder(addr); await mpt.unfreezeHolder(addr)
await mpt.freezeAll();        await mpt.unfreezeAll()
await mpt.ban(addr, 'reason')          // revoke + freeze + claw back all + verify zero
```

A new issuance is created with `MptIssuer.createIssuance(deps, options)`. It enables Can Lock, Require Auth,
Can Clawback and (by default) Can Transfer. It never enables Can Escrow, Can Trade or confidential balances.

Every method re-reads validated ledger state first and is idempotent. Refusals throw `ComplianceError`, and
nothing is submitted. Failed transactions throw `TransactionFailedError`, which carries the result code and the hash.

## Compliance notes (verified against rippled source and on testnet)

- **Freezes block holder-to-holder transfers only.** The ledger still lets the issuer pay a frozen holder, and
  lets a frozen holder pay the issuer. `issue()` refuses to pay a frozen holder or to issue during a global
  freeze. Payments *to* the issuer (redemptions) from a frozen holder can't be blocked on-ledger.
- **A ban is enforced by Require Auth plus the ban registry.** On testnet (`fixCleanup3_4_0` not enabled), a
  banned holder can delete its emptied, frozen MPToken and create a new one. The demo does exactly that. The
  new MPToken is unauthorized, so the holder still can't receive (`tecNO_AUTH`). The module never re-approves
  an address in the registry, so the registry must be durable.
- The module refuses to manage an issuance that has escrow, DEX trading or confidential balances enabled,
  because balances moved there can't be clawed back by `ban()`.
- `DynamicMPT` is not enabled on testnet, so `ImmutableFlags` isn't used. Revisit this when it is enabled:
  after that, the issuer could turn on those capabilities later.
- Submit issuer transactions from a single process. Transactions within one process are serialized to avoid
  `Sequence` collisions.

## Demo

`npm run demo` reads `.env` (`XRPL_WS_URL`, `XRPL_EXPECTED_NETWORK_ID`, `ISSUER_SEED`, `ISSUER_ADDRESS`),
creates holders A/B/C (seeds saved to `.secrets/holders.json`), exercises every control with assertions,
and writes `result.json` and `demo-log.json` (every step with its transaction hash). Each run creates a new
issuance and new holders, and costs about 15 XRP of holder funding.
