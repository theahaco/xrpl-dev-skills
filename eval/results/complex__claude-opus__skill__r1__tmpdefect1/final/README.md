# MPT stablecoin issuer

Issuer-side compliance controls for a regulated token issued as an XRPL
Multi-Purpose Token (MPT). TypeScript (strict), `xrpl` 5.3.0, currently targeting testnet.

```sh
npm install
cp .env.example .env    # set ISSUER_SEED / ISSUER_ADDRESS
npm run typecheck
npm run demo            # exercises every control on testnet, writes result.json
```

## Module (`src/index.ts`)

```ts
const { issuanceId } = await MptIssuer.createIssuance(client, wallet, { assetScale, metadata })
const issuer = await MptIssuer.load({ client, wallet, issuanceId, banStore, audit })

await issuer.approveHolder(addr)          // allowlist (holder must have opted in first)
await issuer.revokeApproval(addr)
await issuer.issue(addr, '100')
await issuer.clawback(addr, '25')         // exact amount, refuses if the balance is lower
await issuer.clawbackAll(addr)
await issuer.freezeHolder(addr) / unfreezeHolder(addr)
await issuer.freezeAll() / unfreezeAll()
await issuer.ban(addr, reason)            // freeze + claw back everything + de-authorize, then verify
await issuer.getHolder(addr) / getIssuance() / getBan(addr)
```

Amounts are decimal strings in human units, converted to integer base units
with `bigint` (no floating point).

## Design notes for compliance

- **Issuance flags:** only `CanLock`, `RequireAuth`, `CanClawback` and
  `CanTransfer` are set. Escrow, DEX trading and confidential balances are
  left off because they would put balances outside the reach of clawback and
  freeze. `MptIssuer.load` refuses any issuance that doesn't match this profile.
  Testnet does not have the `DynamicMPT` amendment enabled, so these flags
  cannot be changed after creation.
- **Freezes don't apply to the issuer on-ledger.** Testing showed that the
  ledger lets the issuer pay a frozen holder, and pay anyone during a global
  freeze. `issue()` therefore checks the freeze state itself and refuses. Any
  other code that signs with the issuer key skips this check.
- **Frozen holders can still send back to the issuer.** This is ledger
  behaviour (the same as trust-line freezes) and the issuer cannot block it.
  Transfers between holders are blocked (`tecLOCKED`).
- **Bans:** the ledger has no native ban. `ban()` records the ban in the
  `BanStore` first, so it fails closed. It then freezes the holder, claws back
  the whole balance, removes the holder's authorization and checks the result
  on-ledger. A banned holder can delete their empty MPToken and opt in again,
  but that gives an *unauthorized* MPToken that cannot receive anything. What
  keeps them out from then on is the module refusing to re-approve them. The
  `BanStore` is therefore a compliance record: in production, back it with
  your primary database, not `FileBanStore`. There is intentionally no "unban".
- **Submission:** `submitAndConfirm` only returns once the transaction is in
  a validated ledger, or is provably expired (past `LastLedgerSequence`, and
  the server confirms it searched every ledger in that range). If the socket
  drops, it doesn't resubmit, so a retry cannot double-issue. `tec` results
  throw `TransactionFailedError`. Issuer transactions are serialized per
  `MptIssuer` instance: run a single instance per issuer account.
- **Audit:** every action, whether it succeeds, fails or is refused, goes to
  the `AuditLogger` (JSON lines on stdout by default).
- **Asset scale:** the demo uses `AssetScale 0` so on-ledger amounts equal
  token amounts. A production stablecoin probably wants 2 or 6. Scale is
  immutable, so decide it before mainnet.
- **Secrets:** `.env`, `.demo-secrets.json` (holder seeds from the demo) and
  `data/` are gitignored. On mainnet the issuer key belongs in an HSM/KMS, not
  in an environment variable.
