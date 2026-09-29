/**
 * End-to-end demo of every compliance control, against XRPL testnet.
 *
 *   ISSUER_SEED=... npm run demo        (or put ISSUER_SEED in .env)
 *
 * End state:
 *   A: approved, holds 500, frozen then unfrozen (not frozen at the end)
 *   B: approved, sent 1000, 300 clawed back (holds 700), frozen at the end
 *   C: approved, sent 250, then banned (holds 0, unapproved, frozen)
 *   The token was globally frozen and unfrozen (not frozen at the end).
 *
 * Writes result.json once the final ledger state has been verified.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { Client, Wallet, xrpToDrops } from 'xrpl'

import {
  ComplianceError,
  FileBanRegistry,
  MptHolder,
  MptIssuer,
  TransactionFailedError,
  TransactionSubmitter,
  type ComplianceReason,
  type Logger,
} from '../src/index.js'

const NETWORK_URL = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'
const HOLDER_FUNDING_XRP = 5
const DATA_DIR = 'data'

const logger: Logger = {
  info: () => undefined, // audit events are written to data/audit.jsonl instead
  warn: (m, f) => console.warn(`  ! ${m}`, f ?? ''),
  error: (m, f) => console.error(`  !! ${m}`, f ?? ''),
}

let step = 0
const section = (title: string): void => console.log(`\n== ${++step}. ${title}`)
const ok = (message: string): void => console.log(`   ok  ${message}`)

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Verification failed: ${message}`)
  ok(message)
}

/** The ledger itself must reject this transaction with one of the given codes. */
async function expectLedgerRejection(label: string, action: Promise<unknown>, codes: string[]): Promise<void> {
  try {
    await action
  } catch (error) {
    if (error instanceof TransactionFailedError && codes.includes(error.engineResult)) {
      ok(`${label} -> rejected by ledger with ${error.engineResult}`)
      return
    }
    throw error
  }
  throw new Error(`${label} was expected to fail with ${codes.join('/')} but succeeded`)
}

/** The issuer module must refuse this action before submitting anything. */
async function expectRefusal(label: string, action: Promise<unknown>, reason: ComplianceReason): Promise<void> {
  try {
    await action
  } catch (error) {
    if (error instanceof ComplianceError && error.reason === reason) {
      ok(`${label} -> refused by policy (${reason})`)
      return
    }
    throw error
  }
  throw new Error(`${label} was expected to be refused with ${reason} but succeeded`)
}

async function main(): Promise<void> {
  const seed = process.env.ISSUER_SEED
  if (seed === undefined || seed === '') throw new Error('ISSUER_SEED is not set (see .env.example)')
  const issuerWallet = Wallet.fromSeed(seed)
  const expected = process.env.ISSUER_ADDRESS
  if (expected !== undefined && expected !== issuerWallet.classicAddress) {
    throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, expected ISSUER_ADDRESS ${expected}`)
  }

  await mkdir(DATA_DIR, { recursive: true })
  const client = new Client(NETWORK_URL)
  await client.connect()
  try {
    await run(client, issuerWallet)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client, issuerWallet: Wallet): Promise<void> {
  section(`Issuer ${issuerWallet.classicAddress} on ${NETWORK_URL}`)
  ok(`balance ${await client.getXrpBalance(issuerWallet.classicAddress)} XRP`)

  // ---------------------------------------------------------------- holders
  section('Create and fund holder accounts A, B, C')
  const wallets = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
  // Save the keys before funding so no funded account is ever orphaned.
  const walletFile = `holders.${Date.now()}.local.json`
  await writeFile(
    walletFile,
    `${JSON.stringify(Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])), null, 2)}\n`,
    { mode: 0o600 },
  )
  ok(`holder keys saved to ${walletFile} (gitignored)`)
  const funder = new TransactionSubmitter(client, issuerWallet, logger)
  for (const [name, wallet] of Object.entries(wallets)) {
    await funder.submit({
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: wallet.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    ok(`${name} = ${wallet.classicAddress}, funded with ${HOLDER_FUNDING_XRP} XRP`)
  }

  // --------------------------------------------------------------- issuance
  section('Create the issuance with all compliance controls')
  const issuer = await MptIssuer.create(
    client,
    issuerWallet,
    {
      assetScale: 0,
      allowHolderTransfers: true,
      metadata: {
        ticker: 'DUSD',
        name: 'Demo Regulated USD (testnet)',
        desc: 'Testnet demonstration of a regulated, allowlisted stablecoin-style MPT.',
        icon: 'example.com/dusd.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Demo Issuer',
      },
    },
    {
      banRegistry: new FileBanRegistry(`${DATA_DIR}/bans.json`),
      logger,
      audit: (event) => appendFile(`${DATA_DIR}/audit.jsonl`, `${JSON.stringify(event)}\n`),
    },
  )
  const id = issuer.issuanceId
  ok(`issuance ${id} (CanLock, RequireAuth, CanClawback, CanTransfer; no escrow/trade/confidential)`)

  const A = new MptHolder(client, wallets.A, id, { logger })
  const B = new MptHolder(client, wallets.B, id, { logger })
  const C = new MptHolder(client, wallets.C, id, { logger })

  // -------------------------------------------------------------- allowlist
  section('Allowlist')
  for (const h of [A, B, C]) await h.optIn()
  ok('A, B and C opted in (created their MPToken entries)')
  await expectRefusal('issue 500 to A before approval', issuer.issue(A.address, 500), 'HOLDER_NOT_AUTHORIZED')
  await issuer.approveHolder(A.address)
  await issuer.approveHolder(B.address)
  ok('A and B approved')
  await issuer.issue(A.address, 500)
  await issuer.issue(B.address, 1000)
  ok('issued 500 to A and 1000 to B')
  await expectLedgerRejection('B sends 10 to unapproved C', B.send(C.address, 10), ['tecNO_AUTH'])
  await issuer.approveHolder(C.address)
  await issuer.issue(C.address, 250)
  ok('C approved and issued 250')

  // ------------------------------------------------------- per-holder freeze
  section('Per-holder freeze')
  await issuer.freezeHolder(A.address)
  check((await issuer.getHolder(A.address)).frozen, 'A is frozen')
  await expectLedgerRejection('frozen A sends 10 to B', A.send(B.address, 10), ['tecLOCKED'])
  await expectLedgerRejection('B sends 10 to frozen A', B.send(A.address, 10), ['tecLOCKED'])
  await expectRefusal('issue 10 to frozen A', issuer.issue(A.address, 10), 'HOLDER_FROZEN')
  await issuer.unfreezeHolder(A.address)
  check(!(await issuer.getHolder(A.address)).frozen, 'A is unfrozen')
  await A.send(B.address, 10)
  await B.send(A.address, 10)
  ok('A and B can transact again (10 each way)')

  // ----------------------------------------------------------- global freeze
  section('Global freeze')
  await issuer.freezeGlobal()
  check((await issuer.getIssuance()).globallyFrozen, 'token is globally frozen')
  await expectLedgerRejection('B sends 10 to A during global freeze', B.send(A.address, 10), ['tecLOCKED'])
  await expectLedgerRejection('C sends 10 to A during global freeze', C.send(A.address, 10), ['tecLOCKED'])
  await expectRefusal('issue 10 to A during global freeze', issuer.issue(A.address, 10), 'GLOBALLY_FROZEN')
  await issuer.unfreezeGlobal()
  check(!(await issuer.getIssuance()).globallyFrozen, 'global freeze lifted')
  await B.send(A.address, 10)
  await A.send(B.address, 10)
  ok('transfers work again (10 each way)')

  // --------------------------------------------------------------- clawback
  section('Clawback')
  await expectRefusal('claw back 5000 from B (holds 1000)', issuer.clawback(B.address, 5000), 'INSUFFICIENT_BALANCE')
  const claw = await issuer.clawback(B.address, 300)
  check(claw.amount === 300n, `clawed back ${claw.amount} from B`)
  check((await B.balance()) === 700n, 'B holds 700')

  // -------------------------------------------------------------------- ban
  section('Ban')
  const ban = await issuer.ban(C.address, 'Demo: sanctions screening hit')
  check(ban.clawedBack === 250n, `ban clawed back C's entire balance (${ban.clawedBack})`)
  await expectLedgerRejection('A sends 10 to banned C', A.send(C.address, 10), ['tecNO_AUTH', 'tecLOCKED'])
  await expectRefusal('issue 10 to banned C', issuer.issue(C.address, 10), 'HOLDER_BANNED')
  await expectRefusal('re-approve banned C', issuer.approveHolder(C.address), 'HOLDER_BANNED')
  await expectRefusal('unfreeze banned C', issuer.unfreezeHolder(C.address), 'HOLDER_BANNED')

  // ------------------------------------------------------------ final state
  section('Freeze B (final state)')
  await issuer.freezeHolder(B.address)
  ok('B frozen')

  section('Verify final ledger state')
  await issuer.assertCompliantIssuance()
  ok('issuance configuration is compliant')
  const issuance = await issuer.getIssuance()
  check(!issuance.globallyFrozen, 'token is not globally frozen')
  check(issuance.outstanding === 1200n, `outstanding supply is ${issuance.outstanding}`)
  const [a, b, c] = await Promise.all([A, B, C].map((h) => issuer.getHolder(h.address)))
  if (a === undefined || b === undefined || c === undefined) throw new Error('unreachable')
  check(a.authorized && !a.frozen && a.balance === 500n && !a.banned, 'A: approved, not frozen, holds 500')
  check(b.authorized && b.frozen && b.balance === 700n && !b.banned, 'B: approved, frozen, holds 700')
  check(c.banned && !c.authorized && c.frozen && c.balance === 0n, 'C: banned, unapproved, frozen, holds 0')

  const result = {
    issuanceId: id,
    holders: { A: A.address, B: B.address, C: C.address },
  }
  await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`)
  section('Done')
  console.log(JSON.stringify(result, null, 2))
  ok(`issuer balance now ${await client.getXrpBalance(issuerWallet.classicAddress)} XRP`)
}

main().catch((error: unknown) => {
  console.error('\nDEMO FAILED:', error)
  process.exitCode = 1
})
