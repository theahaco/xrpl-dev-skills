/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   npm run demo        (reads ISSUER_SEED and XRPL_URL from .env)
 *
 * Creates a new MPT issuance from the issuer account plus three new holder
 * accounts (A, B, C) funded from the issuer. It exercises the allowlist,
 * clawback, per-holder and global freezes and bans, verifies the final ledger
 * state, and writes result.json (plus demo-report.json with every
 * transaction hash).
 */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import { Client, ECDSA, Wallet, xrpToDrops, type SubmittableTransaction } from 'xrpl'

import {
  ComplianceError,
  JsonFileBanRegistry,
  MPTokenIssuanceFlags,
  MptHolder,
  MptIssuer,
  Submitter,
  TransactionFailedError,
  type ActionReceipt,
  type HolderState,
} from '../src/index.js'

const TESTNET_NETWORK_ID = 1
const HOLDER_FUNDING_XRP = '5'

const report: { step: string; hash?: string; result: string }[] = []

function log(message: string): void {
  console.log(message)
}

function record(step: string, result: string, hash?: string): void {
  report.push({ step, result, ...(hash === undefined ? {} : { hash }) })
  log(`  ✓ ${step}: ${result}${hash === undefined ? '' : ` (${hash})`}`)
}

function recordReceipt(step: string, receipt: ActionReceipt): void {
  if (receipt.transactions.length === 0) {
    record(step, 'already in requested state')
  }
  for (const tx of receipt.transactions) {
    record(step, `${tx.type} tesSUCCESS in ledger ${tx.ledgerIndex}`, tx.hash)
  }
}

/** Asserts that a ledger transaction is validated with a specific tec code. */
async function expectLedgerRejection(step: string, promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TransactionFailedError && error.resultCode === code) {
      record(step, `rejected by the ledger with ${code}`, error.hash)
      return
    }
    throw error
  }
  throw new Error(`${step}: expected ${code} but the transaction succeeded`)
}

/** Asserts that the issuer module refuses an action before submitting it. */
async function expectModuleRefusal(step: string, promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ComplianceError) {
      record(step, `refused by the module: ${error.message}`)
      return
    }
    throw error
  }
  throw new Error(`${step}: expected a ComplianceError but the action succeeded`)
}

/** Dry-runs a transaction with the `simulate` method (nothing is submitted). */
async function simulate(client: Client, tx: SubmittableTransaction): Promise<string> {
  const response = await client.simulate(tx)
  return response.result.engine_result
}

async function expectHolder(issuer: MptIssuer, address: string, expected: Omit<HolderState, 'address' | 'lockedAmount'>): Promise<void> {
  const actual = await issuer.getHolder(address)
  assert.deepEqual(
    { ...actual, address: undefined, lockedAmount: undefined },
    { ...expected, address: undefined, lockedAmount: undefined },
    `holder ${address} state mismatch`,
  )
  assert.equal(actual.lockedAmount, 0n)
}

async function main(): Promise<void> {
  const seed = process.env['ISSUER_SEED']
  const url = process.env['XRPL_URL'] ?? 'wss://s.altnet.rippletest.net:51233'
  if (seed === undefined || seed === '') {
    throw new Error('ISSUER_SEED is not set (see .env.example)')
  }
  // xrpl v5 infers the key type from the seed prefix; be explicit anyway.
  const issuerWallet = Wallet.fromSeed(seed, { algorithm: seed.startsWith('sEd') ? ECDSA.ed25519 : ECDSA.secp256k1 })
  const expectedIssuer = process.env['ISSUER_ADDRESS']
  if (expectedIssuer !== undefined && expectedIssuer !== issuerWallet.classicAddress) {
    throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, not ISSUER_ADDRESS ${expectedIssuer}`)
  }

  const client = new Client(url)
  await client.connect()
  try {
    if (client.networkID !== TESTNET_NETWORK_ID) {
      throw new Error(`Refusing to run: ${url} reports network ID ${client.networkID}, expected testnet (${TESTNET_NETWORK_ID})`)
    }
    const issuerAddress = issuerWallet.classicAddress
    log(`Issuer ${issuerAddress} on ${url}`)
    log(`Issuer balance: ${await client.getXrpBalance(issuerAddress)} XRP`)

    // ------------------------------------------------------------ setup
    log('\n[1] Create and fund holder accounts A, B, C')
    const wallets = {
      A: Wallet.generate(ECDSA.ed25519),
      B: Wallet.generate(ECDSA.ed25519),
      C: Wallet.generate(ECDSA.ed25519),
    }
    const A = wallets.A.classicAddress
    const B = wallets.B.classicAddress
    const C = wallets.C.classicAddress
    {
      const funder = new Submitter(client, issuerWallet)
      for (const [name, wallet] of Object.entries(wallets)) {
        const result = await funder.submit({
          TransactionType: 'Payment',
          Account: issuerAddress,
          Destination: wallet.classicAddress,
          Amount: xrpToDrops(HOLDER_FUNDING_XRP),
        })
        record(`fund ${name} ${wallet.classicAddress}`, `${HOLDER_FUNDING_XRP} XRP`, result.hash)
      }
    }
    const holders = {
      A: new MptHolder(client, wallets.A),
      B: new MptHolder(client, wallets.B),
      C: new MptHolder(client, wallets.C),
    }

    log('\n[2] Create the MPT issuance')
    const { issuer, transaction } = await MptIssuer.createIssuance(
      client,
      issuerWallet,
      {
        metadata: {
          ticker: 'RUSD',
          name: 'Regulated USD (testnet demo)',
          desc: 'Demo of a regulated, allowlisted stablecoin-style MPT. Testnet only; no value.',
          icon: 'example.com/rusd.png',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Demo Issuer',
        },
        assetScale: 0,
        canTransfer: true,
      },
      { banRegistry: new JsonFileBanRegistry('data/bans.json') },
    )
    const issuanceId = issuer.issuanceId
    record('MPTokenIssuanceCreate', `issuance ${issuanceId}`, transaction.hash)
    const created = await issuer.getIssuance()
    log(`  flags=0x${created.flags.toString(16)} (RequireAuth, CanLock, CanClawback, CanTransfer)`)
    // Raw issuer transactions below bypass the module on purpose, to show
    // what the ledger itself enforces. They run strictly after/before module
    // calls, so the two submitters never race for the issuer's Sequence.
    const rawIssuer = new Submitter(client, issuerWallet)
    const mpt = (value: string) => ({ mpt_issuance_id: issuanceId, value })

    log('\n[3] Holders opt in (each signs its own MPTokenAuthorize)')
    for (const [name, holder] of Object.entries(holders)) {
      record(`${name} opts in`, 'MPToken created', (await holder.optIn(issuanceId)).hash)
    }

    // ------------------------------------------------------------ allowlist
    log('\n[4] Allowlist: unapproved holders cannot receive the token')
    await expectModuleRefusal('module: issue 500 to unapproved A', issuer.issue(A, '500'))
    await expectLedgerRejection(
      'ledger: raw issuer payment to unapproved A',
      rawIssuer.submit({ TransactionType: 'Payment', Account: issuerAddress, Destination: A, Amount: mpt('500') }),
      'tecNO_AUTH',
    )
    for (const [name, address] of Object.entries({ A, B, C })) {
      recordReceipt(`approve ${name} (post-KYC)`, await issuer.approveHolder(address))
    }

    log('\n[5] Issue tokens')
    recordReceipt('issue 500 to A', await issuer.issue(A, '500'))
    recordReceipt('issue 1000 to B', await issuer.issue(B, '1000'))
    recordReceipt('issue 100 to C', await issuer.issue(C, '100'))

    // ------------------------------------------------------------ clawback
    log('\n[6] Clawback 300 from B')
    const clawed = await issuer.clawback(B, '300')
    assert.equal(clawed.amountClawedBack, 300n)
    recordReceipt('claw back 300 from B', clawed)
    assert.equal((await issuer.getHolder(B)).balance, 700n)
    record('B balance', '700')

    // ------------------------------------------------------------ per-holder freeze
    log('\n[7] Per-holder freeze of A')
    recordReceipt('freeze A', await issuer.freezeHolder(A))
    await expectLedgerRejection('frozen A sends 1 to B', holders.A.send(issuanceId, B, '1'), 'tecLOCKED')
    await expectLedgerRejection('B sends 1 to frozen A', holders.B.send(issuanceId, A, '1'), 'tecLOCKED')
    await expectModuleRefusal('module: issue 1 to frozen A', issuer.issue(A, '1'))
    // Protocol facts behind the module's guard (dry run, nothing submitted):
    const issuerToFrozen = await simulate(client, { TransactionType: 'Payment', Account: issuerAddress, Destination: A, Amount: mpt('1') })
    record('protocol probe (simulate): raw issuer payment to frozen A', `${issuerToFrozen}; the ledger allows it, so the module blocks it`)
    const frozenToIssuer = await simulate(client, { TransactionType: 'Payment', Account: A, Destination: issuerAddress, Amount: mpt('1') })
    record('protocol probe (simulate): frozen A redeems 1 to issuer', `${frozenToIssuer}; redemption to the issuer is allowed during a lock`)
    recordReceipt('unfreeze A', await issuer.unfreezeHolder(A))
    record('A sends 10 to B after unfreeze', 'tesSUCCESS', (await holders.A.send(issuanceId, B, '10')).hash)
    record('B returns 10 to A', 'tesSUCCESS', (await holders.B.send(issuanceId, A, '10')).hash)

    // ------------------------------------------------------------ global freeze
    log('\n[8] Global freeze')
    recordReceipt('freeze all', await issuer.freezeAll())
    assert.equal((await issuer.getIssuance()).globallyFrozen, true)
    await expectLedgerRejection('A sends 1 to B during global freeze', holders.A.send(issuanceId, B, '1'), 'tecLOCKED')
    await expectLedgerRejection('C sends 1 to B during global freeze', holders.C.send(issuanceId, B, '1'), 'tecLOCKED')
    await expectModuleRefusal('module: issue 1 to B during global freeze', issuer.issue(B, '1'))
    recordReceipt('unfreeze all', await issuer.unfreezeAll())
    record('B sends 5 to A after global unfreeze', 'tesSUCCESS', (await holders.B.send(issuanceId, A, '5')).hash)
    record('A returns 5 to B', 'tesSUCCESS', (await holders.A.send(issuanceId, B, '5')).hash)

    // ------------------------------------------------------------ ban
    log('\n[9] Ban C')
    const ban = await issuer.ban(C, 'Demo: sanctions screening hit')
    assert.equal(ban.amountClawedBack, 100n)
    recordReceipt('ban C (unauthorize, lock, claw back 100)', ban)
    await expectLedgerRejection(
      'ledger: raw issuer payment to banned C',
      rawIssuer.submit({ TransactionType: 'Payment', Account: issuerAddress, Destination: C, Amount: mpt('1') }),
      'tecNO_AUTH',
    )
    await expectLedgerRejection('A sends 1 to banned C', holders.A.send(issuanceId, C, '1'), 'tecNO_AUTH')
    await expectModuleRefusal('module: re-approve banned C', issuer.approveHolder(C))
    await expectModuleRefusal('module: issue to banned C', issuer.issue(C, '1'))
    await expectModuleRefusal('module: unfreeze banned C', issuer.unfreezeHolder(C))

    // ------------------------------------------------------------ final state
    log('\n[10] Freeze B (final state)')
    recordReceipt('freeze B', await issuer.freezeHolder(B))

    log('\n[11] Verify final ledger state')
    const issuance = await issuer.getIssuance()
    assert.equal(issuance.issuer, issuerAddress)
    for (const flag of ['lsfMPTRequireAuth', 'lsfMPTCanLock', 'lsfMPTCanClawback', 'lsfMPTCanTransfer'] as const) {
      assert.ok(issuance.flags & MPTokenIssuanceFlags[flag], `issuance missing ${flag}`)
    }
    assert.equal(issuance.globallyFrozen, false)
    assert.equal(issuance.outstandingAmount, 1200n)
    await expectHolder(issuer, A, { hasMPToken: true, approved: true, frozen: false, balance: 500n, banned: false })
    await expectHolder(issuer, B, { hasMPToken: true, approved: true, frozen: true, balance: 700n, banned: false })
    await expectHolder(issuer, C, { hasMPToken: true, approved: false, frozen: true, balance: 0n, banned: true })
    record('final state', 'issuance not globally frozen; A=500 approved unfrozen; B=700 approved frozen; C=0 banned')

    const result = { issuanceId, holders: { A, B, C } }
    await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`)
    await writeFile(
      'demo-report.json',
      `${JSON.stringify({ network: url, issuer: issuerAddress, ...result, steps: report }, null, 2)}\n`,
    )
    log('\nWrote result.json and demo-report.json')
    log(JSON.stringify(result, null, 2))
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('\nDEMO FAILED:', error)
  if (report.length > 0) {
    console.error('Steps completed before failure:', JSON.stringify(report, null, 2))
  }
  process.exitCode = 1
})
