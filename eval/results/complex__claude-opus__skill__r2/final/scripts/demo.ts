/**
 * Exercises every compliance control against XRPL testnet and leaves the
 * ledger in the documented end state (see README.md).
 *
 *   XRPL_ISSUER_SEED=s... npm run demo
 *
 * Optional: XRPL_ISSUER_ADDRESS (sanity check for the seed), XRPL_WS_URL.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Client, Wallet, xrpToDrops } from 'xrpl'
import {
  ComplianceError,
  FileBanRegistry,
  MptIssuer,
  optIn,
  submitAndConfirm,
  transfer,
  TransactionFailedError,
  type AuditEntry,
  type SubmitResult,
} from '../src'
import { checkFinalState, TESTNET_NETWORK_ID, type DemoResult } from './expectations'

const ROOT = path.resolve(__dirname, '..')
const WS_URL = process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233'
const HOLDER_FUNDING_XRP = '3'

type Step = { step: string; outcome: string; hash?: string }
const transcript: Step[] = []
const audit: AuditEntry[] = []

function log(step: string, outcome: string, hash?: string) {
  const entry: Step = hash === undefined ? { step, outcome } : { step, outcome, hash }
  transcript.push(entry)
  console.log(`  ${outcome.startsWith('FAIL') ? '✗' : '✓'} ${step}: ${outcome}${hash ? `  [${hash}]` : ''}`)
}

function section(title: string) {
  console.log(`\n== ${title}`)
}

/** Submits something the ledger must reject; throws if it is accepted. */
async function expectLedgerRejects(step: string, expected: string[], attempt: () => Promise<SubmitResult>) {
  try {
    const result = await attempt()
    log(step, 'FAIL - ledger ACCEPTED it', result.hash)
    throw new Error(`Control failure: "${step}" was accepted by the ledger (tx ${result.hash})`)
  } catch (error) {
    if (!(error instanceof TransactionFailedError)) throw error
    if (!expected.includes(error.resultCode)) {
      log(step, `FAIL - rejected with unexpected ${error.resultCode}`, error.hash)
      throw error
    }
    log(step, `rejected by ledger with ${error.resultCode}`, error.hash)
  }
}

/** A redemption the ledger accepted, which the redemption guard must refuse to pay out. */
async function expectPayoutRefused(issuer: MptIssuer, step: string, hash: string) {
  const assessment = await issuer.assessRedemption(hash)
  if (assessment.payoutAllowed) throw new Error(`Control failure: payout allowed for "${step}" (tx ${hash})`)
  log(step, `ledger accepted; payout refused: ${assessment.reasons.join('; ')}`, hash)
}

/** Calls a module method that must refuse on policy grounds before submitting. */
async function expectModuleRefuses(step: string, attempt: () => Promise<unknown>) {
  try {
    await attempt()
  } catch (error) {
    if (error instanceof ComplianceError) {
      log(step, `refused by issuer module: ${error.message}`)
      return
    }
    throw error
  }
  throw new Error(`Control failure: "${step}" was not refused by the issuer module`)
}

function assertEqual<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}

async function main() {
  const seed = process.env.XRPL_ISSUER_SEED
  if (!seed) throw new Error('Set XRPL_ISSUER_SEED to the issuer account seed')
  const issuerWallet = Wallet.fromSeed(seed)
  const expectedAddress = process.env.XRPL_ISSUER_ADDRESS
  if (expectedAddress && expectedAddress !== issuerWallet.classicAddress) {
    throw new Error(`Seed derives ${issuerWallet.classicAddress}, expected ${expectedAddress}`)
  }

  const client = new Client(WS_URL)
  await client.connect()
  try {
    const info = await client.request({ command: 'server_info' })
    const networkId = (info.result.info as { network_id?: number }).network_id
    if (networkId !== TESTNET_NETWORK_ID) {
      throw new Error(`Refusing to run: ${WS_URL} is network ${String(networkId)}, not testnet (${TESTNET_NETWORK_ID})`)
    }
    console.log(`Issuer ${issuerWallet.classicAddress} on testnet via ${WS_URL}`)
    await run(client, issuerWallet)
  } finally {
    await fs.writeFile(path.join(ROOT, 'demo-run.json'), JSON.stringify({ transcript, audit }, null, 2) + '\n')
    await client.disconnect()
  }
}

async function run(client: Client, issuerWallet: Wallet) {
  const issuerAddress = issuerWallet.classicAddress
  const id = { issuanceId: '' }
  const mpt = (value: string) => ({ mpt_issuance_id: id.issuanceId, value })
  const issuerPays = (to: string, value: string) =>
    submitAndConfirm(client, issuerWallet, { TransactionType: 'Payment', Account: issuerAddress, Destination: to, Amount: mpt(value) })

  // ------------------------------------------------------------------ setup
  section('Create the issuance')
  const created = await MptIssuer.createIssuance(client, issuerWallet, {
    assetScale: 0,
    metadata: {
      ticker: 'RUSD',
      name: 'Regulated USD (testnet demo)',
      desc: 'Testnet demonstration of an allowlisted, freezable, clawback-enabled stablecoin.',
      icon: 'https://example.com/rusd.png',
      asset_class: 'rwa',
      asset_subclass: 'stablecoin',
      issuer_name: 'Demo Issuer (testnet)',
    },
  })
  id.issuanceId = created.issuanceId
  log('MPTokenIssuanceCreate (RequireAuth + CanClawback + CanLock + CanTransfer)', `issuance ${created.issuanceId}`, created.hash)

  const banRegistry = new FileBanRegistry(path.join(ROOT, 'data', `bans-${created.issuanceId}.json`))
  const issuer = await MptIssuer.load({
    client,
    issuerWallet,
    issuanceId: created.issuanceId,
    banRegistry,
    onAudit: (entry) => audit.push(entry),
  })
  const caps = (await issuer.getIssuance()).capabilities
  log('Issuance capabilities', JSON.stringify(caps))

  section('Create and fund holders A, B, C')
  const wallets = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
  // Persist the (testnet) holder seeds before funding so they are never lost.
  const walletFile = path.join(ROOT, '.demo-wallets.json')
  await fs.writeFile(
    walletFile,
    JSON.stringify(
      { issuanceId: created.issuanceId, holders: Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])) },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  const holders = { A: wallets.A.classicAddress, B: wallets.B.classicAddress, C: wallets.C.classicAddress }
  for (const [name, wallet] of Object.entries(wallets)) {
    const r = await submitAndConfirm(client, issuerWallet, {
      TransactionType: 'Payment',
      Account: issuerAddress,
      Destination: wallet.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    log(`Fund ${name} (${wallet.classicAddress}) with ${HOLDER_FUNDING_XRP} XRP`, 'ok', r.hash)
  }
  for (const [name, wallet] of Object.entries(wallets)) {
    const r = await optIn(client, wallet, created.issuanceId)
    log(`${name} opts in (holder MPTokenAuthorize)`, 'ok', r.hash)
  }

  // --------------------------------------------------------------- allowlist
  section('Allowlist')
  await expectModuleRefuses('issue to A before KYC approval', () => issuer.issue(holders.A, 1n))
  await expectLedgerRejects('ledger: issuer pays unapproved A', ['tecNO_AUTH'], () => issuerPays(holders.A, '1'))
  for (const name of ['A', 'B', 'C'] as const) {
    const r = await issuer.approveHolder(holders[name], { reference: `KYC-DEMO-${name}` })
    log(`Approve ${name}`, 'ok', r?.hash)
  }

  section('Issue tokens')
  for (const [name, amount] of [['A', 500n], ['B', 1000n], ['C', 100n]] as const) {
    const r = await issuer.issue(holders[name], amount)
    log(`Issue ${amount} to ${name}`, 'ok', r.hash)
  }

  // ------------------------------------------------------- per-holder freeze
  section('Per-holder freeze (A)')
  log('Freeze A', 'ok', (await issuer.freezeHolder(holders.A, { reference: 'DEMO-FREEZE-A' })).hash)
  assertEqual((await issuer.getHolder(holders.A)).frozen, true, 'A frozen')
  await expectModuleRefuses('issue to frozen A', () => issuer.issue(holders.A, 1n))
  await expectLedgerRejects('ledger: B pays frozen A', ['tecLOCKED'], () => transfer(client, wallets.B, holders.A, id.issuanceId, 1n))
  await expectLedgerRejects('ledger: frozen A pays B', ['tecLOCKED'], () => transfer(client, wallets.A, holders.B, id.issuanceId, 1n))
  log('Unfreeze A', 'ok', (await issuer.unfreezeHolder(holders.A, { reference: 'DEMO-FREEZE-A' })).hash)
  assertEqual((await issuer.getHolder(holders.A)).frozen, false, 'A frozen')
  // Round trip proves A can move tokens again, without changing any balance.
  log('A pays C 1 after unfreeze', 'ok', (await transfer(client, wallets.A, holders.C, id.issuanceId, 1n)).hash)
  log('C pays A 1 back', 'ok', (await transfer(client, wallets.C, holders.A, id.issuanceId, 1n)).hash)

  // ---------------------------------------------------------------- clawback
  section('Clawback (B)')
  await expectModuleRefuses('claw back more than B holds', () => issuer.clawback(holders.B, 1001n))
  log('Claw back 300 from B', 'ok', (await issuer.clawback(holders.B, 300n, { reference: 'DEMO-CLAWBACK-B' })).hash)
  assertEqual((await issuer.getHolder(holders.B)).balance, 700n, 'B balance')

  // ------------------------------------------------------------ redemptions
  section('Redemption guard')
  const redemption = await transfer(client, wallets.C, issuerAddress, id.issuanceId, 1n)
  const allowed = await issuer.assessRedemption(redemption.hash)
  assertEqual(allowed.payoutAllowed, true, 'payout allowed for normal redemption')
  log('C redeems 1 (not frozen)', `payout allowed for ${allowed.amount}`, redemption.hash)

  // ----------------------------------------------------------- global freeze
  section('Global freeze')
  log('Freeze all', 'ok', (await issuer.freezeAll({ reference: 'DEMO-INCIDENT' })).hash)
  assertEqual((await issuer.getIssuance()).globallyFrozen, true, 'globally frozen')
  await expectModuleRefuses('issue during global freeze', () => issuer.issue(holders.C, 1n))
  await expectLedgerRejects('ledger: A pays B during global freeze', ['tecLOCKED'], () => transfer(client, wallets.A, holders.B, id.issuanceId, 1n))
  await expectLedgerRejects('ledger: C pays A during global freeze', ['tecLOCKED'], () => transfer(client, wallets.C, holders.A, id.issuanceId, 1n))
  // The ledger lock does not cover payments to the issuer, so a redemption
  // still lands; the redemption guard must refuse to pay it out.
  const frozenRedemption = await transfer(client, wallets.C, issuerAddress, id.issuanceId, 1n)
  await expectPayoutRefused(issuer, 'C redeems 1 during global freeze', frozenRedemption.hash)
  log('Unfreeze all', 'ok', (await issuer.unfreezeAll({ reference: 'DEMO-INCIDENT' })).hash)
  assertEqual((await issuer.getIssuance()).globallyFrozen, false, 'globally frozen')
  log('C pays A 1 after global unfreeze', 'ok', (await transfer(client, wallets.C, holders.A, id.issuanceId, 1n)).hash)
  log('A pays C 1 back', 'ok', (await transfer(client, wallets.A, holders.C, id.issuanceId, 1n)).hash)

  // ----------------------------------------------------- final freeze of B
  section('Freeze B (stays frozen)')
  log('Freeze B', 'ok', (await issuer.freezeHolder(holders.B, { reference: 'DEMO-FREEZE-B' })).hash)

  // --------------------------------------------------------------------- ban
  section('Ban (C)')
  const cBefore = await issuer.getHolder(holders.C)
  const ban = await issuer.ban(holders.C, 'Demo: sanctions screening hit', { reference: 'DEMO-BAN-C' })
  log(
    `Ban C (held ${cBefore.balance})`,
    `approval revoked [${ban.revokeHash ?? 'n/a'}], clawed back ${ban.totalClawedBack} in ${ban.clawbacks.length} tx`,
    ban.clawbacks[0]?.hash,
  )
  const cAfter = await issuer.getHolder(holders.C)
  assertEqual(cAfter.balance, 0n, 'C balance')
  assertEqual(cAfter.approved, false, 'C approved')
  await expectModuleRefuses('re-approve banned C', () => issuer.approveHolder(holders.C))
  await expectModuleRefuses('issue to banned C', () => issuer.issue(holders.C, 1n))
  await expectLedgerRejects('ledger: issuer pays banned C', ['tecNO_AUTH'], () => issuerPays(holders.C, '1'))
  await expectLedgerRejects('ledger: A pays banned C', ['tecNO_AUTH'], () => transfer(client, wallets.A, holders.C, id.issuanceId, 1n))

  // ------------------------------------------------------------ verification
  section('Verify final ledger state')
  const result: DemoResult = { issuanceId: created.issuanceId, holders }
  const verdict = await checkFinalState(client, issuerAddress, result)
  for (const c of verdict.checks) log(c.description, c.ok ? 'ok' : 'FAIL')
  await fs.writeFile(path.join(ROOT, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(`\nWrote result.json for issuance ${created.issuanceId}`)
  if (!verdict.ok) throw new Error('Final ledger state does not match the expected state')
}

main().catch((error: unknown) => {
  console.error('\nDEMO FAILED:', error)
  process.exitCode = 1
})
