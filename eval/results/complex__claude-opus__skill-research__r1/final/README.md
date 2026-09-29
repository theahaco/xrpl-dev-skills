# MPT compliance issuer

Issuer-side controls for a regulated, allow-listed Multi-Purpose Token (XLS-33) on the XRP Ledger.
Built with `xrpl` 5.3.0 and TypeScript 7 (strict), and tested against testnet (rippled 3.4.1).

```sh
npm install
npm run typecheck && npm test
npm run demo        # needs .env: XRPL_NETWORK_URL, ISSUER_ADDRESS, ISSUER_SEED
```

## API (`src/index.ts`)

```ts
const issuer = await MptIssuer.attach(client, wallet, issuanceId, { banRegistry })
// or: await MptIssuer.createIssuance(client, wallet, { metadata, assetScale }, { banRegistry })

await issuer.approveHolder(addr)          // allowlist after KYC (holder must opt in first)
await issuer.revokeApproval(addr)
await issuer.issue(addr, 500n)            // amounts are integer base units (see toBaseUnits)
await issuer.clawback(addr, 300n)         // → { clawedBack } (ledger caps at balance)
await issuer.freezeHolder(addr) / unfreezeHolder(addr)
await issuer.freezeAll() / unfreezeAll()
await issuer.banHolder(addr, reason)      // record ban → unauthorize → lock → claw back all → verify
await issuer.getHolderStatus(addr) / getIssuanceStatus() / simulatePayment(from, to, amt)
```

Every write waits for a validated ledger and throws `TransactionFailedError` unless the result is `tesSUCCESS`.
Submissions from one instance are serialized, so use **one instance per issuing account**.

## Design decisions (verified on testnet, 2026-09-29)

- **Issuance flags:** Can Lock, Require Auth, Can Clawback and Can Transfer are on. Can Escrow, Can Trade and
  confidential balances are off, and no `DomainID` is set. `attach()` refuses an issuance that doesn't match this.
  - Escrowed MPT (`TokenEscrow` is live) sits in `LockedAmount`, which Clawback can't reach.
  - A permissioned domain would authorize holders by credential, which bypasses the allowlist and bans.
- **Flags are permanent:** `DynamicMPT` is not enabled on testnet, so these flags can't change after creation.
  If `DynamicMPT` is enabled later, the issuer could switch capabilities on, but only by explicitly sending a
  transaction to do so.
- **Freezes and issuer payments:** the ledger rejects holder↔holder payments while either side is locked or the
  token is globally locked (`tecLOCKED`). However, it still **accepts issuer→holder payments** in both cases.
  `issue()` therefore refuses frozen holders and a globally frozen token itself.
- **Bans:** the ledger alone can't keep a ban permanent. Once a banned holder's balance is zero, they can delete
  their `MPToken` entry, which removes the lock (testnet doesn't have `fixCleanup3_4_0`). The `BanRegistry` is
  checked before every approval and issuance. `JsonFileBanRegistry` is for the demo only; in production, back
  the registry with your compliance database.
- **Clawback** works regardless of freeze or approval state. It fails with `tecINSUFFICIENT_FUNDS` if the
  balance is zero, and `banHolder` handles that case.
