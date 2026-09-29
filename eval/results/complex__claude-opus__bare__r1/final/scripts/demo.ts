/**
 * Exercises every compliance control against XRPL testnet:
 * allowlist, clawback, ban, per-holder freeze and global freeze.
 *
 *   cp .env.example .env   # then set ISSUER_SEED
 *   npm run demo
 *
 * Creates three holder accounts (A, B, C), funds them from the issuer, and
 * writes result.json. Holder seeds are saved to .demo-wallets.json (gitignored).
 */
import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { Client, Wallet, type SubmittableTransaction, xrpToDrops } from 'xrpl'
import {
  type AuditEvent,
  ComplianceViolationError,
  JsonFileBanRegistry,
  MptIssuer,
  Submitter,
  TransactionFailedError,
} from '../src/index.js'

const HOLDER_FUNDING_XRP = '5'

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`)
  return value
}

const step = (title: string) => console.log(`\n=== ${title}`)
const ok = (message: string) => console.log(`  ✓ ${message}`)

/** Asserts that the module refuses the action with this compliance code, before anything is submitted. */
async function expectRefused(action: Promise<unknown>, code: ComplianceViolationError['code'], what: string) {
  try {
    await action
  } catch (error) {
    if (error instanceof ComplianceViolationError && error.code === code) {
      ok(`${what}: refused by the issuer module (${code})`)
      return
    }
    throw error
  }
  throw new Error(`${what}: expected refusal ${code}, but it succeeded`)
}

/** Asserts that the XRP Ledger itself rejects the transaction with this result code. */
async function expectLedgerRejects(action: Promise<unknown>, code: string, what: string) {
  try {
    await action
  } catch (error) {
    if (error instanceof TransactionFailedError && error.resultCode === code) {
      ok(`${what}: rejected by the ledger (${code}, tx ${error.hash})`)
      return
    }
    throw error
  }
  throw new Error(`${what}: expected ledger result ${code}, but it succeeded`)
}

/** Holder-side actions. In production these run in the holder's own wallet, not in the issuer backend. */
class DemoHolder {
  private readonly submitter: Submitter
  constructor(
    readonly name: string,
    readonly wallet: Wallet,
    client: Client,
    private readonly issuanceId: () => string,
  ) {
    this.submitter = new Submitter(client, wallet)
  }
  get address() {
    return this.wallet.classicAddress
  }
  private submit(tx: SubmittableTransaction) {
    return this.submitter.exclusive(() => this.submitter.submitUnlocked(tx))
  }
  optIn() {
    return this.submit({ TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: this.issuanceId() })
  }
  send(to: DemoHolder, value: string) {
    return this.submit({
      TransactionType: 'Payment',
      Account: this.address,
      Destination: to.address,
      Amount: { mpt_issuance_id: this.issuanceId(), value },
    })
  }
}

async function main() {
  const client = new Client(process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233')
  await client.connect()
  try {
    await run(client)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client) {
  const issuerWallet = Wallet.fromSeed(env('ISSUER_SEED'))
  const expectedNetworkId = Number(process.env.XRPL_NETWORK_ID ?? '1')
  const auditLog: AuditEvent[] = []
  const options = {
    client,
    signer: issuerWallet,
    banRegistry: new JsonFileBanRegistry('data/bans.json'),
    expectedNetworkId,
    audit: (event: AuditEvent) => {
      auditLog.push(event)
    },
  }

  step(`Issuer ${issuerWallet.classicAddress}`)
  const info = await client.request({ command: 'server_info' })
  assert.equal(info.result.info.network_id ?? 0, expectedNetworkId, 'Connected to the wrong network')
  ok(`connected to network id ${expectedNetworkId} (${client.url})`)

  // ---------------------------------------------------------------- holders
  step('Create and fund holder accounts A, B, C')
  let issuanceId = ''
  const [A, B, C] = (['A', 'B', 'C'] as const).map(
    (name) => new DemoHolder(name, Wallet.generate(), client, () => issuanceId),
  ) as [DemoHolder, DemoHolder, DemoHolder]
  // Save the seeds before funding, so the funded accounts are never lost.
  await writeFile(
    '.demo-wallets.json',
    `${JSON.stringify(Object.fromEntries([A, B, C].map((h) => [h.name, { address: h.address, seed: h.wallet.seed }])), null, 2)}\n`,
    { mode: 0o600 },
  )
  const funder = new Submitter(client, issuerWallet)
  for (const holder of [A, B, C]) {
    await funder.exclusive(() =>
      funder.submitUnlocked({
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: holder.address,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      }),
    )
    ok(`${holder.name} = ${holder.address} funded with ${HOLDER_FUNDING_XRP} XRP`)
  }

  // --------------------------------------------------------------- issuance
  step('Create the MPT issuance')
  const issuer = await MptIssuer.create(
    options,
    {
      assetScale: 0,
      maximumAmount: '1000000000',
      transferable: true,
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated USD (testnet demo)',
        desc: 'Testnet demonstration of an allowlisted, freezable, clawback-enabled stablecoin.',
        icon: 'https://xrpl.org/favicon.ico',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Demo Issuer',
      },
    },
    { actor: 'demo-script' },
  )
  issuanceId = issuer.issuanceId
  const created = await issuer.getIssuance()
  assert.deepEqual(created.capabilities, {
    canLock: true,
    requireAuth: true,
    canClawback: true,
    canTransfer: true,
    canEscrow: false,
    canTrade: false,
  })
  ok(`issuance ${issuanceId}`)
  ok('capabilities: lock, require-auth, clawback, transfer (no escrow, no DEX/AMM)')
  // Check that load() accepts the issuance we just created.
  await MptIssuer.load(options, issuanceId)

  // -------------------------------------------------------------- allowlist
  step('Allowlist')
  await expectRefused(issuer.issue(A.address, '500'), 'HOLDER_NOT_OPTED_IN', 'issue to A before opt-in')
  for (const holder of [A, B, C]) await holder.optIn()
  ok('A, B, C opted in (MPTokenAuthorize from each holder)')
  await expectRefused(issuer.issue(A.address, '500'), 'HOLDER_NOT_AUTHORIZED', 'issue to A before approval')
  await issuer.approveHolder(A.address, { reference: 'KYC-A' })
  await issuer.approveHolder(B.address, { reference: 'KYC-B' })
  ok('A and B approved')
  await issuer.issue(A.address, '500')
  await issuer.issue(B.address, '1000')
  ok('issued 500 to A, 1000 to B')
  await expectLedgerRejects(A.send(C, '10'), 'tecNO_AUTH', 'A -> C while C is not approved')
  await issuer.approveHolder(C.address, { reference: 'KYC-C' })
  await issuer.issue(C.address, '250')
  ok('C approved and issued 250')
  assert.equal(await issuer.approveHolder(C.address), undefined, 'approving twice should be a no-op')

  // ------------------------------------------------------ per-holder freeze
  step('Per-holder freeze (A)')
  await issuer.freezeHolder(A.address, 'Suspicious activity review', { reference: 'CASE-1' })
  assert.equal((await issuer.getHolder(A.address)).frozen, true)
  ok('A frozen')
  await expectLedgerRejects(A.send(B, '1'), 'tecLOCKED', 'A -> B while A is frozen')
  await expectLedgerRejects(B.send(A, '1'), 'tecLOCKED', 'B -> A while A is frozen')
  await expectRefused(issuer.issue(A.address, '1'), 'HOLDER_FROZEN', 'issue to A while A is frozen')
  await issuer.unfreezeHolder(A.address, 'Review cleared', { reference: 'CASE-1' })
  assert.equal((await issuer.getHolder(A.address)).frozen, false)
  ok('A unfrozen')
  await A.send(C, '25')
  await C.send(A, '25')
  ok('A -> C 25 and C -> A 25 succeed again (A can send and receive)')

  // ----------------------------------------------------------- global freeze
  step('Global freeze')
  await issuer.freezeAll('Incident drill', { reference: 'INC-1' })
  assert.equal((await issuer.getIssuance()).globallyFrozen, true)
  ok('token globally frozen')
  await expectLedgerRejects(A.send(B, '1'), 'tecLOCKED', 'A -> B during global freeze')
  await expectLedgerRejects(B.send(C, '1'), 'tecLOCKED', 'B -> C during global freeze')
  await expectRefused(issuer.issue(B.address, '1'), 'GLOBALLY_FROZEN', 'issue during global freeze')
  await issuer.unfreezeAll('Incident resolved', { reference: 'INC-1' })
  assert.equal((await issuer.getIssuance()).globallyFrozen, false)
  ok('global freeze lifted')
  await B.send(A, '1')
  await A.send(B, '1')
  ok('B -> A 1 and A -> B 1 succeed again')

  // ---------------------------------------------------------------- clawback
  step('Clawback (B)')
  await expectRefused(
    issuer.clawback(B.address, '1001', 'over-balance test'),
    'INSUFFICIENT_BALANCE',
    'claw back more than B holds',
  )
  const clawed = await issuer.clawback(B.address, '300', 'Court order', { reference: 'ORDER-7' })
  assert.equal(clawed.clawedBack, '300')
  assert.equal((await issuer.getHolder(B.address)).balance, '700')
  ok(`clawed back 300 from B (tx ${clawed.hash}); B holds 700`)

  // --------------------------------------------------------------------- ban
  step('Ban (C)')
  const cBefore = await issuer.getHolder(C.address)
  const banned = await issuer.ban(C.address, 'Sanctions list match', { reference: 'SANCTIONS-3' })
  assert.equal(banned.clawedBack, cBefore.balance)
  ok(`C banned; clawed back ${banned.clawedBack} (txs ${banned.transactions.join(', ')})`)
  const cAfter = await issuer.getHolder(C.address)
  assert.equal(cAfter.balance, '0')
  assert.equal(cAfter.authorized, false)
  ok('C holds 0 and is no longer approved')
  await expectLedgerRejects(A.send(C, '1'), 'tecNO_AUTH', 'A -> C after ban')
  await expectRefused(issuer.issue(C.address, '1'), 'HOLDER_BANNED', 'issue to C after ban')
  await expectRefused(issuer.approveHolder(C.address), 'HOLDER_BANNED', 're-approve C after ban')
  await expectRefused(issuer.unfreezeHolder(C.address, 'test'), 'HOLDER_BANNED', 'unfreeze C after ban')
  const again = await issuer.ban(C.address, 'repeat')
  assert.deepEqual(again.transactions, [])
  ok('ban() is idempotent (second call submits nothing and keeps the original record)')

  // ------------------------------------------------------ final freeze of B
  step('Freeze B')
  await issuer.freezeHolder(B.address, 'Pending investigation', { reference: 'CASE-2' })
  await expectLedgerRejects(B.send(A, '1'), 'tecLOCKED', 'B -> A while B is frozen')

  // ------------------------------------------------------------ verification
  step('Verify final ledger state')
  const issuance = await issuer.getIssuance()
  const [a, b, c] = await Promise.all([A, B, C].map((h) => issuer.getHolder(h.address)))
  assert.equal(issuance.issuer, issuerWallet.classicAddress)
  assert.equal(issuance.globallyFrozen, false)
  assert.equal(issuance.outstandingAmount, '1200')
  assert.deepEqual(
    { ...a, ban: a?.ban !== undefined },
    { address: A.address, optedIn: true, authorized: true, frozen: false, balance: '500', ban: false },
  )
  assert.deepEqual(
    { ...b, ban: b?.ban !== undefined },
    { address: B.address, optedIn: true, authorized: true, frozen: true, balance: '700', ban: false },
  )
  assert.equal(c?.balance, '0')
  assert.equal(c?.authorized, false)
  assert.notEqual(c?.ban, undefined)
  console.log(JSON.stringify({ issuance, holders: { A: a, B: b, C: c } }, null, 2))
  ok('all expected state verified on the validated ledger')

  const result = { issuanceId, holders: { A: A.address, B: B.address, C: C.address } }
  await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`)
  ok('wrote result.json')
  await writeFile('data/audit-log.json', `${JSON.stringify(auditLog, null, 2)}\n`)
  ok(`wrote data/audit-log.json (${auditLog.length} events)`)
  console.log(`\nExplorer: https://testnet.xrpl.org/mpt/${issuanceId}`)
}

main().catch((error: unknown) => {
  console.error('\nDEMO FAILED:', error)
  process.exitCode = 1
})
