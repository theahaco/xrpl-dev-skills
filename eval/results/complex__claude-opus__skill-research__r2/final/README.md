# MPT issuer: compliance controls for a regulated token on the XRP Ledger

A TypeScript module (`src/`) that the backend calls to manage one Multi-Purpose Token (MPT) issuance with these controls:

| Control | Method(s) | Enforced by |
|---|---|---|
| Allowlist (KYC) | `approveHolder`, `revokeApproval` | Ledger: the issuance has `RequireAuth`, so unapproved holders get `tecNO_AUTH` |
| Clawback | `clawback(addr, amount)`, `clawbackAll(addr)` | Ledger: `CanClawback` |
| Ban | `ban(addr, reason)`, `enforceBans()` | Ban list, then freeze, claw back the whole balance, and revoke approval |
| Per-holder freeze | `freezeHolder`, `unfreezeHolder` | Ledger (`tecLOCKED` for holder-to-holder transfers) plus a module guard on `issue` |
| Global freeze | `freezeAll`, `unfreezeAll` | Ledger (`tecLOCKED`) plus a module guard on `issue` |

Built on `xrpl@5.3.0`, TypeScript 7.0.2 (strict), and Node ≥ 22. Checked against testnet (rippled 3.4.1) on 2026-09-29.

## Usage

```sh
npm install
cp .env.example .env    # fill in ISSUER_ADDRESS / ISSUER_SEED
npm test                # unit tests
npm run demo            # full demo on testnet; writes result.json
```

```ts
const client = await connectClient(loadXrplConfig())
const issuer = await MptIssuer.connect(client, loadIssuerWallet(), issuanceId, {
  banList: new JsonFileBanList('state/ban-list.json'), // or your DB-backed BanList
  logger,                                             // audit events + tx hashes
})
await issuer.approveHolder(addr)       // after the holder opts in (MPTokenAuthorize)
await issuer.issue(addr, '100.25')     // amounts are decimal strings in token units
await issuer.ban(addr, 'OFAC match #1234')
```

## Design notes (read before relying on this)

- **The issuance's capabilities are permanent.** `DynamicMPT` is not enabled on testnet, so `CanLock`, `RequireAuth`, `CanClawback` and `CanTransfer` are fixed when the issuance is created. `MptIssuer.connect` refuses issuances that lack them. It also refuses issuances with `CanEscrow`, `CanTrade` or confidential balances, because escrowed tokens are outside the holder's balance and can't be taken back by a ban's clawback.
- **Freezes don't stop issuer payments on the ledger.** rippled lets the issuer pay a locked holder, even during a global lock; a lock only blocks transfers between holders. Holders can also still send tokens back to the issuer (a burn). To meet "a frozen holder can't receive", `issue()` refuses frozen holders and refuses everything during a global freeze. Only send tokens through this module.
- **Bans rely on the ban list plus `RequireAuth`, not on the lock.** Without the `fixCleanup3_4_0` amendment (not enabled on testnet), a banned holder can delete their locked, empty MPToken entry. The demo shows this happening. Their new entry starts unapproved, so the ledger still rejects every payment to them. The ban list is the durable record that stops anyone approving them again. `enforceBans()` re-freezes such re-created entries; run it periodically.
- **Reliable submission.** Every transaction gets a `LastLedgerSequence`. Only `tesSUCCESS` in a validated ledger counts as success. An unknown outcome raises `TransactionOutcomeUnknownError` with the hash: reconcile before retrying anything that moves value. Operations are serialized per `MptIssuer` instance. Run one instance per issuer account, or add external locking.
- **Amounts** use BigInt only and are never rounded. Input with more decimals than `AssetScale` is rejected. The demo uses `AssetScale: 0`, so "500 tokens" is an on-ledger `MPTAmount` of `500`.
- **Keys.** The seed comes from the environment and must derive to `ISSUER_ADDRESS`. The client refuses to run if the server's network ID doesn't match `XRPL_NETWORK_ID`. For production, move signing to a KMS/HSM and consider a regular key or multi-signing for the issuer.

## Files

- `src/issuer.ts`: `MptIssuer`, the issuer controls
- `src/submitter.ts`: serialized sign, submit and wait for validation
- `src/banList.ts`: `BanList` interface, in-memory and JSON-file implementations
- `src/amount.ts`: conversion between token units and base units
- `src/holder.ts`: holder-side actions (used by the demo)
- `scripts/demo.ts`: testnet demo; `demo-output.log` is the output of the run that produced `result.json`
- `.secrets/holders.json` (git-ignored): seeds of the demo holder accounts
