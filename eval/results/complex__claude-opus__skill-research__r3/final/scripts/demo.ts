/**
 * Testnet demo: creates a compliance-controlled MPT issued by ISSUER_SEED's
 * account, creates holders A, B and C, exercises every control (checking that
 * forbidden movements really fail on the ledger), verifies the final state and
 * writes result.json.
 */
import { mkdir, writeFile } from 'node:fs/promises'

import dotenv from 'dotenv'
import { Client, dropsToXrp, ECDSA, Wallet, xrpToDrops } from 'xrpl'

import {
  type AuditEvent,
  ComplianceViolationError,
  type ComplianceViolationCode,
  FileBanList,
  loadConfig,
  MptIssuer,
  optIn,
  submitTransaction,
  transfer,
  XrplTransactionError,
} from '../src/index.js'
import { checkFinalState, type DemoHolders, formatState } from './expectations.js'

dotenv.config({ quiet: true })

const HOLDER_FUNDING_XRP = '5'
const EXPLORER = 'https://testnet.xrpl.org/transactions/'

async function main(): Promise<void> {
  const config = loadConfig()
  const client = new Client(config.wsUrl)
  await client.connect()
  try {
    await run(client, config.issuerWallet, config.banListPath)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client, issuerWallet: Wallet, banListPath: string): Promise<void> {
  const balance = await client.getXrpBalance(issuerWallet.address)
  log(`Issuer ${issuerWallet.address} on network ${client.networkID ?? '?'}, balance ${balance} XRP`)

  const deps = {
    banList: new FileBanList(banListPath),
    onAudit: (e: AuditEvent) =>
      log(`  audit ${e.action}${e.holder ? ` holder=${e.holder}` : ''}${e.amount ? ` amount=${e.amount}` : ''}` +
        `${e.txHash ? ` ${EXPLORER}${e.txHash}` : ''}`),
  }

  step('Create the MPT issuance')
  const issuer = await MptIssuer.createIssuance(
    client,
    issuerWallet,
    {
      assetScale: 0,
      allowHolderTransfers: true,
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated USD (testnet demo)',
        desc: 'Testnet demo of an allowlisted, freezable, clawback-enabled stablecoin-style MPT.',
        icon: 'https://example.com/rusd.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Demo Issuer',
      },
    },
    deps,
  )
  const issuanceId = issuer.issuanceId
  log(`Issuance ID ${issuanceId}`)

  step('Create and fund holder accounts A, B, C')
  const wallets = {
    A: Wallet.generate(ECDSA.ed25519),
    B: Wallet.generate(ECDSA.ed25519),
    C: Wallet.generate(ECDSA.ed25519),
  }
  const holders: DemoHolders = { A: wallets.A.address, B: wallets.B.address, C: wallets.C.address }
  // Save seeds before funding so the XRP is recoverable if the demo crashes.
  await mkdir('.secrets', { recursive: true })
  await writeFile(
    '.secrets/demo-holders.json',
    `${JSON.stringify({ issuanceId, holders: mapValues(wallets, (w) => ({ address: w.address, seed: w.seed })) }, null, 2)}\n`,
    { mode: 0o600 },
  )
  for (const [label, wallet] of Object.entries(wallets)) {
    const tx = await submitTransaction(client, issuerWallet, {
      TransactionType: 'Payment',
      Account: issuerWallet.address,
      Destination: wallet.address,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    log(`${label} = ${wallet.address}, funded ${HOLDER_FUNDING_XRP} XRP ${EXPLORER}${tx.hash}`)
  }

  step('Holders opt in to the token')
  for (const [label, wallet] of Object.entries(wallets)) {
    const tx = await optIn(client, wallet, issuanceId)
    log(`${label} opted in ${EXPLORER}${tx.hash}`)
  }

  step('Allowlist: unapproved holders cannot receive')
  await expectCompliance(issuer.issue(holders.A, '1'), 'HOLDER_NOT_AUTHORIZED', 'issue to A before approval')

  step('Allowlist: approve A, B and C after KYC')
  for (const address of Object.values(holders)) await issuer.authorizeHolder(address)
  const again = await issuer.authorizeHolder(holders.A)
  assert(!again.changed, 'Re-approving A should be a no-op')
  log('Re-approving A is a no-op (idempotent)')

  step('Issue tokens')
  await issuer.issue(holders.A, '500')
  await issuer.issue(holders.B, '1000')
  await issuer.issue(holders.C, '250')

  step('Approved holders can transfer to each other')
  await transfer(client, wallets.A, holders.B, issuanceId, 10n)
  await transfer(client, wallets.B, holders.A, issuanceId, 10n)
  log('A -> B 10 and B -> A 10 both succeeded')

  step('Per-holder freeze: freeze A')
  await issuer.freezeHolder(holders.A, 'demo: suspicious activity review')
  await expectLedger(transfer(client, wallets.A, holders.B, issuanceId, 1n), 'tecLOCKED', 'frozen A sends to B')
  await expectLedger(transfer(client, wallets.B, holders.A, issuanceId, 1n), 'tecLOCKED', 'B sends to frozen A')
  await expectCompliance(issuer.issue(holders.A, '1'), 'HOLDER_FROZEN', 'issue to frozen A')

  step('Per-holder freeze: unfreeze A')
  await issuer.unfreezeHolder(holders.A, 'demo: review cleared')
  assert(!(await issuer.getHolderState(holders.A)).frozen, 'A should be unfrozen')

  step('Clawback: claw back 300 from B')
  await expectCompliance(issuer.clawback(holders.B, '1001', 'demo'), 'INVALID_AMOUNT', 'claw back more than B holds')
  const clawed = await issuer.clawback(holders.B, '300', 'demo: court order')
  assert(clawed.clawedBack === '300', `Expected 300 clawed back, got ${clawed.clawedBack}`)
  assert((await issuer.getHolderState(holders.B)).balance === '700', 'B should hold 700')

  step('Global freeze')
  await issuer.freezeAll('demo: incident response')
  await expectLedger(transfer(client, wallets.B, holders.A, issuanceId, 1n), 'tecLOCKED', 'B sends to A during global freeze')
  await expectLedger(transfer(client, wallets.A, holders.B, issuanceId, 1n), 'tecLOCKED', 'A sends to B during global freeze')
  await expectCompliance(issuer.issue(holders.A, '1'), 'GLOBALLY_FROZEN', 'issue during global freeze')

  step('Lift the global freeze')
  await issuer.unfreezeAll('demo: incident resolved')
  assert(!(await issuer.getIssuanceState()).globallyFrozen, 'Token should not be globally frozen')

  step('Ban C')
  const ban = await issuer.banHolder(holders.C, 'demo: sanctions list match')
  assert(ban.clawedBack === '250', `Expected 250 clawed back from C, got ${ban.clawedBack}`)
  await expectLedger(transfer(client, wallets.A, holders.C, issuanceId, 1n), 'tecNO_AUTH', 'A sends to banned C')
  await expectCompliance(issuer.authorizeHolder(holders.C), 'HOLDER_BANNED', 're-approve banned C')
  await expectCompliance(issuer.issue(holders.C, '1'), 'HOLDER_BANNED', 'issue to banned C')
  await expectCompliance(issuer.unfreezeHolder(holders.C, 'demo'), 'HOLDER_BANNED', 'unfreeze banned C')

  step('Freeze B (final state)')
  await issuer.freezeHolder(holders.B, 'demo: account under investigation')

  step('Verify final ledger state')
  const problems = await checkFinalState(issuer, holders)
  log(
    formatState(await issuer.getIssuanceState(), {
      A: await issuer.getHolderState(holders.A),
      B: await issuer.getHolderState(holders.B),
      C: await issuer.getHolderState(holders.C),
    }),
  )
  if (problems.length > 0) throw new Error(`Final state check failed:\n  ${problems.join('\n  ')}`)

  await writeFile('result.json', `${JSON.stringify({ issuanceId, holders }, null, 2)}\n`)
  log('All checks passed; wrote result.json')
  log(`Issuer XRP spent: ${dropsToXrp(BigInt(xrpToDrops(balance)) - BigInt(xrpToDrops(await client.getXrpBalance(issuerWallet.address))))} XRP`)
}

/** Asserts a holder transaction is rejected by the ledger with `code`. */
async function expectLedger(promise: Promise<unknown>, code: string, what: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    if (error instanceof XrplTransactionError && error.engineResult === code) {
      log(`OK: ${what} rejected by the ledger with ${code}`)
      return
    }
    throw error
  }
  throw new Error(`Expected "${what}" to fail with ${code}, but it succeeded`)
}

/** Asserts the issuer module refuses an action with `code`, before submitting anything. */
async function expectCompliance(promise: Promise<unknown>, code: ComplianceViolationCode, what: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ComplianceViolationError && error.code === code) {
      log(`OK: ${what} refused by the issuer module (${code})`)
      return
    }
    throw error
  }
  throw new Error(`Expected "${what}" to be refused with ${code}, but it succeeded`)
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function mapValues<T, U>(obj: Record<string, T>, fn: (v: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]))
}

function step(title: string): void {
  console.log(`\n== ${title}`)
}

function log(message: string): void {
  console.log(message)
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:', error)
  process.exitCode = 1
})
