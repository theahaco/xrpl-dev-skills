/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   npm run demo
 *
 * Reads ISSUER_SEED / ISSUER_ADDRESS / XRPL_URL from the environment (or .env).
 * Creates a fresh issuance and three fresh holder accounts funded by the issuer,
 * exercises each control (including the negative cases), verifies the final
 * ledger state and writes result.json.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { Client, Wallet, xrpToDrops } from 'xrpl'

import {
  ComplianceError,
  FileBanStore,
  MptIssuer,
  optIn,
  submitAndConfirm,
  TransactionFailedError,
  transfer,
  type HolderState,
} from './index.js'

const ASSET_SCALE = 0
const HOLDER_FUNDING_XRP = '5'

if (existsSync('.env')) process.loadEnvFile('.env')
const seed = requireEnv('ISSUER_SEED')
const expectedIssuer = process.env.ISSUER_ADDRESS
const url = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'

const issuerWallet = Wallet.fromSeed(seed)
if (expectedIssuer !== undefined && expectedIssuer !== '' && issuerWallet.classicAddress !== expectedIssuer) {
  throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, expected ${expectedIssuer}`)
}

const client = new Client(url)
await client.connect()
try {
  await main()
} finally {
  await client.disconnect()
}

async function main(): Promise<void> {
  const network = await client.request({ command: 'server_info' })
  if (network.result.info.network_id !== 1) {
    throw new Error(`Refusing to run the demo: ${url} is not XRPL testnet (network_id ${network.result.info.network_id})`)
  }

  step('Create and fund holder accounts A, B, C')
  const holders = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
  // Keep the holder seeds so the accounts remain usable after the demo (gitignored).
  await writeFile(
    '.demo-secrets.json',
    `${JSON.stringify(Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])), null, 2)}\n`,
    { mode: 0o600 },
  )
  for (const [name, wallet] of Object.entries(holders)) {
    await submitAndConfirm(client, issuerWallet, {
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: wallet.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    log(`${name} = ${wallet.classicAddress} funded with ${HOLDER_FUNDING_XRP} XRP`)
  }
  const { A, B, C } = holders
  const a = A.classicAddress
  const b = B.classicAddress
  const c = C.classicAddress

  step('Create the MPT issuance')
  const { issuanceId, txHash } = await MptIssuer.createIssuance(client, issuerWallet, {
    assetScale: ASSET_SCALE,
    metadata: {
      ticker: 'RUSD',
      name: 'Regulated USD (testnet demo)',
      desc: 'Testnet demo of a regulated, allowlisted USD stablecoin issued as an MPT.',
      icon: 'https://xrpl.org/favicon.ico',
      asset_class: 'rwa',
      asset_subclass: 'stablecoin',
      issuer_name: 'Demo Issuer',
    },
  })
  log(`issuance ${issuanceId} (tx ${txHash})`)
  const issuer = await MptIssuer.load({
    client,
    wallet: issuerWallet,
    issuanceId,
    banStore: new FileBanStore(`data/bans-${issuanceId}.json`),
  })
  const send = async (from: Wallet, to: string, amount: string) =>
    transfer(client, from, to, issuanceId, amount, ASSET_SCALE)

  step('Holders opt in')
  for (const wallet of [A, B, C]) await optIn(client, wallet, issuanceId)

  step('Allowlist')
  await expectRefused('issue to A before approval', () => issuer.issue(a, '1'))
  await issuer.approveHolder(a)
  await issuer.approveHolder(b)
  await issuer.issue(a, '500')
  await issuer.issue(b, '1000')
  await expectLedgerFailure('A -> C while C is not approved', 'tecNO_AUTH', () => send(A, c, '1'))
  await issuer.approveHolder(c)
  await issuer.issue(c, '250')
  await expectHolder('A', a, { balance: '500', authorized: true })
  await expectHolder('B', b, { balance: '1000', authorized: true })
  await expectHolder('C', c, { balance: '250', authorized: true })

  step('Clawback')
  await expectRefused('claw back more than B holds', () => issuer.clawback(b, '1001'))
  await issuer.clawback(b, '300')
  await expectHolder('B', b, { balance: '700' })

  step('Per-holder freeze')
  await issuer.freezeHolder(a)
  await expectHolder('A', a, { locked: true })
  await expectRefused('issue to frozen A', () => issuer.issue(a, '1'))
  await expectLedgerFailure('frozen A -> B', 'tecLOCKED', () => send(A, b, '1'))
  await expectLedgerFailure('B -> frozen A', 'tecLOCKED', () => send(B, a, '1'))
  await issuer.unfreezeHolder(a)
  await expectHolder('A', a, { locked: false })
  await send(A, b, '25')
  await send(B, a, '25')
  log('A can send and receive again (25 round trip A -> B -> A)')

  step('Global freeze')
  await issuer.freezeAll()
  await expectIssuance({ globallyLocked: true })
  await expectRefused('issue during global freeze', () => issuer.issue(b, '1'))
  await expectLedgerFailure('A -> B during global freeze', 'tecLOCKED', () => send(A, b, '1'))
  await expectLedgerFailure('B -> A during global freeze', 'tecLOCKED', () => send(B, a, '1'))
  await issuer.unfreezeAll()
  await expectIssuance({ globallyLocked: false })
  await send(A, b, '1')
  await send(B, a, '1')
  log('movement resumed (1 round trip A -> B -> A)')

  step('Freeze B (stays frozen)')
  await issuer.freezeHolder(b)
  await expectLedgerFailure('frozen B -> A', 'tecLOCKED', () => send(B, a, '1'))

  step('Ban C')
  await issuer.ban(c, 'Demo: sanctions screening hit')
  await expectHolder('C', c, { balance: '0', authorized: false, locked: true })
  await expectRefused('re-approve banned C', () => issuer.approveHolder(c))
  await expectRefused('issue to banned C', () => issuer.issue(c, '1'))
  await expectRefused('unfreeze banned C', () => issuer.unfreezeHolder(c))
  await expectLedgerFailure('A -> banned C', 'tecNO_AUTH', () => send(A, c, '1'))

  step('Verify final state')
  await expectIssuance({ globallyLocked: false, outstanding: '1200' })
  await expectHolder('A', a, { balance: '500', authorized: true, locked: false })
  await expectHolder('B', b, { balance: '700', authorized: true, locked: true })
  await expectHolder('C', c, { balance: '0', authorized: false, locked: true })
  if ((await issuer.getBan(c))?.enforcedAt === undefined) throw new Error('C ban is not recorded as enforced')
  log('all checks passed')

  const result = { issuanceId, holders: { A: a, B: b, C: c } }
  await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`)
  log(`wrote result.json:\n${JSON.stringify(result, null, 2)}`)

  // ------------------------------------------------------------ helpers

  async function expectHolder(name: string, address: string, expected: Partial<HolderState>): Promise<void> {
    const actual = await issuer.getHolder(address)
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key as keyof HolderState] !== value) {
        throw new Error(`${name}.${key}: expected ${String(value)}, got ${String(actual[key as keyof HolderState])}`)
      }
    }
    log(`${name}: balance ${actual.balance}, authorized ${actual.authorized}, frozen ${actual.locked}`)
  }

  async function expectIssuance(expected: { globallyLocked?: boolean; outstanding?: string }): Promise<void> {
    const actual = await issuer.getIssuance()
    if (expected.globallyLocked !== undefined && actual.globallyLocked !== expected.globallyLocked) {
      throw new Error(`issuance globallyLocked: expected ${expected.globallyLocked}, got ${actual.globallyLocked}`)
    }
    if (expected.outstanding !== undefined && actual.outstanding !== expected.outstanding) {
      throw new Error(`issuance outstanding: expected ${expected.outstanding}, got ${actual.outstanding}`)
    }
    log(`issuance: globally frozen ${actual.globallyLocked}, outstanding ${actual.outstanding}`)
  }
}

async function expectRefused(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ComplianceError || error instanceof RangeError) {
      log(`refused as expected: ${label} (${error.message})`)
      return
    }
    throw error
  }
  throw new Error(`Expected the module to refuse: ${label}`)
}

async function expectLedgerFailure(label: string, code: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof TransactionFailedError && error.code === code) {
      log(`rejected by ledger as expected: ${label} (${code})`)
      return
    }
    throw error
  }
  throw new Error(`Expected the ledger to reject with ${code}: ${label}`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`)
  return value
}

function step(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function log(message: string): void {
  console.log(`  ${message}`)
}
