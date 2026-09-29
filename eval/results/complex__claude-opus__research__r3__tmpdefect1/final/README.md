# MPT stablecoin issuer

Issuer-side compliance controls for a regulated, stablecoin-style
[Multi-Purpose Token](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)
on the XRP Ledger. TypeScript (strict), `xrpl` 5.3.0, Node ≥ 22.

```sh
npm install
npm test        # unit tests
npm run demo    # end-to-end demo on testnet; needs .env (see .env.example)
```

## Usage

```ts
import { Client, ECDSA, Wallet } from 'xrpl'
import { InMemoryBanStore, MptIssuer } from 'mpt-stablecoin-issuer'

const client = new Client('wss://s.altnet.rippletest.net:51233')
await client.connect()
const wallet = Wallet.fromSeed(process.env.ISSUER_SEED!, { algorithm: ECDSA.ed25519 })

// Once: create the issuance (every control flag is set here and cannot be added later).
const created = await MptIssuer.createIssuance(client, wallet, { assetScale: 2, metadata }, { banStore })
// Afterwards: manage the existing issuance.
const issuer = await MptIssuer.open(client, wallet, created.issuanceId, { banStore })

await issuer.authorizeHolder(addr)        // allowlist (holder must opt in first)
await issuer.revokeAuthorization(addr)
await issuer.issue(addr, '1000.00')       // display units, converted using AssetScale
await issuer.clawback(addr, '300')        // or 'all'
await issuer.freezeHolder(addr) / unfreezeHolder(addr)
await issuer.freezeAll() / unfreezeAll()
await issuer.ban(addr, 'reason')          // freeze + claw back everything + revoke; recorded in ban store
await issuer.getHolder(addr) / getIssuance()
```

Every mutating call waits for a validated ledger, checks the resulting state and
throws a typed error (`ComplianceError`, `PreconditionError`,
`TransactionFailedError`, `TransactionOutcomeUnknownError`, `VerificationError`).
Calls are idempotent where that makes sense (e.g. authorizing an authorized holder is a no-op).

## Design notes

- **Issuance flags:** `RequireAuth | CanLock | CanClawback | CanTransfer`. The
  `DynamicMPT` amendment is not enabled on testnet or mainnet, so flags can't be
  changed after creation. `open()` refuses any issuance that lacks one of them.
  `CanEscrow` is left off on purpose: escrowed balances can't be clawed back by a ban.
- **Freezes and issuer payments:** an MPT lock stops transfers between holders
  but does **not** stop the issuer paying a locked holder (confirmed on testnet).
  `issue()` refuses to pay frozen holders, or anyone while the token is globally
  frozen. Mint only through this module.
- **Bans** are stored in a `BanStore`, because on the ledger a banned address
  looks the same as one that hasn't been approved yet. Replace `InMemoryBanStore` with a durable
  implementation (e.g. your KYC database) in production. On the ledger, a banned holder
  ends up locked, unauthorized and at zero balance, so `RequireAuth` rejects any
  payment to it (`tecNO_AUTH`).
- **One signer per issuer account.** Operations are serialized within an
  `MptIssuer` instance; separate processes signing for the same account will
  collide on the account sequence.
- **Unknown outcomes:** if the connection drops mid-submit you get
  `TransactionOutcomeUnknownError` with the transaction hash. Look it up
  before retrying.
