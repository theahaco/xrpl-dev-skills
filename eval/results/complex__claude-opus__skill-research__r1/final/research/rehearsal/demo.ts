/**
 * Testnet demo: creates a compliance-controlled MPT from the configured issuer,
 * funds three new holders (A, B, C), exercises every control, verifies the final
 * ledger state and writes result.json.
 *
 *   npm run demo        (reads XRPL_NETWORK_URL, ISSUER_ADDRESS, ISSUER_SEED from .env)
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Client, ECDSA, Wallet, xrpToDrops } from 'xrpl'

import {
  BannedHolderError,
  FrozenError,
  JsonFileBanRegistry,
  MptIssuer,
  optInAsHolder,
  submitTransaction,
  type HolderStatus,
  type TxReceipt,
} from '../../src/index.js'

const TESTNET_NETWORK_ID = 1
const REQUIRED_AMENDMENTS = ['MPTokensV1', 'Clawback']
const HOLDER_FUNDING_XRP = '5'
const EXPLORER = 'https://testnet.xrpl.org/transactions'
const ROOT = resolve(import.meta.dirname)

function env(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function step(title: string): void {
  console.log(`\n== ${title}`)
}

function logTx(label: string, receipt: TxReceipt | undefined): void {
  console.log(receipt ? `   ✓ ${label}  ${EXPLORER}/${receipt.hash}` : `   ✓ ${label}  (already in effect)`)
}

async function expectPayment(
  issuer: MptIssuer,
  label: string,
  from: string,
  to: string,
  expectSuccess: boolean,
): Promise<void> {
  const result = await issuer.simulatePayment(from, to, 1n)
  const ok = result === 'tesSUCCESS'
  if (ok !== expectSuccess) {
    throw new Error(`Enforcement check failed: ${label} -> ${result} (expected ${expectSuccess ? 'success' : 'rejection'})`)
  }
  console.log(`   ✓ ${label}: ${result}`)
}

/** Log what the ledger alone would do, without asserting (issuer payments bypass locks on-ledger). */
async function reportLedger(issuer: MptIssuer, label: string, from: string, to: string): Promise<void> {
  console.log(`   i ${label}: ledger alone returns ${await issuer.simulatePayment(from, to, 1n)}`)
}

async function main(): Promise<void> {
  const client = new Client(env('XRPL_NETWORK_URL'))
  await client.connect()
  try {
    step('Preflight')
    if (client.networkID !== TESTNET_NETWORK_ID) {
      throw new Error(`Connected to network ${client.networkID}; this demo only runs on testnet (${TESTNET_NETWORK_ID})`)
    }
    const features = await client.request({ command: 'feature' })
    const byName = new Map(Object.values(features.result.features).map((f) => [f.name, f.enabled]))
    for (const amendment of REQUIRED_AMENDMENTS) {
      if (byName.get(amendment) !== true) throw new Error(`Amendment ${amendment} is not enabled on this network`)
    }
    console.log(`   network ${client.networkID}; amendments enabled: ${REQUIRED_AMENDMENTS.join(', ')}`)

    // xrpl.js 5 infers the algorithm from the seed prefix; be explicit anyway.
    const { wallet: issuerWallet } = await client.fundWallet(null, { faucetHost: 'faucet.altnet.rippletest.net' })
    console.log(`   issuer ${issuerWallet.classicAddress}: ${await client.getXrpBalance(issuerWallet.classicAddress)} XRP`)

    step('Create and fund holder accounts A, B, C')
    const holders = {
      A: Wallet.generate(ECDSA.ed25519),
      B: Wallet.generate(ECDSA.ed25519),
      C: Wallet.generate(ECDSA.ed25519),
    }
    // Persist keys before funding so no funded account is ever unrecoverable.
    await mkdir(resolve(ROOT, 'secrets'), { recursive: true })
    await writeFile(
      resolve(ROOT, 'secrets', `holders-${Date.now()}.json`),
      JSON.stringify(
        Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])),
        null,
        2,
      ),
      { mode: 0o600 },
    )
    for (const [name, wallet] of Object.entries(holders)) {
      const receipt = await submitTransaction(client, issuerWallet, {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      })
      logTx(`funded ${name} ${wallet.classicAddress} with ${HOLDER_FUNDING_XRP} XRP`, receipt)
    }
    const { A, B, C } = {
      A: holders.A.classicAddress,
      B: holders.B.classicAddress,
      C: holders.C.classicAddress,
    }

    step('Create the MPT issuance')
    const issuer = await MptIssuer.createIssuance(
      client,
      issuerWallet,
      {
        metadata: {
          ticker: 'RUSD',
          name: 'Regulated USD (testnet demo)',
          desc: 'Demo of a regulated, allow-listed stablecoin-style MPT on XRPL testnet.',
          icon: 'example.com/rusd.png',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Example Issuer (testnet)',
        },
        assetScale: 0,
        transferable: true,
      },
      { banRegistry: new JsonFileBanRegistry(resolve(ROOT, 'data', 'bans.json')) },
    )
    const created = await issuer.getIssuanceStatus()
    console.log(`   ✓ issuance ${issuer.issuanceId}`)
    console.log(
      `     requireAuth=${created.requireAuth} canLock=${created.canLock} canClawback=${created.canClawback} ` +
        `canTransfer=${created.canTransfer} canEscrow=${created.canEscrow} canTrade=${created.canTrade}`,
    )

    step('Allowlist: holders opt in; only approved holders can receive')
    for (const [name, wallet] of Object.entries(holders)) {
      logTx(`${name} opted in`, await optInAsHolder(client, wallet, issuer.issuanceId))
    }
    await expectPayment(issuer, 'issuer -> A before approval is rejected', issuer.issuer, A, false)
    for (const [name, address] of Object.entries({ A, B, C })) {
      logTx(`approved ${name}`, await issuer.approveHolder(address))
    }
    await expectPayment(issuer, 'issuer -> A after approval is allowed', issuer.issuer, A, true)

    step('Issue tokens')
    logTx('issued 500 to A', await issuer.issue(A, 500n))
    logTx('issued 1000 to B', await issuer.issue(B, 1000n))
    logTx('issued 250 to C', await issuer.issue(C, 250n))
    await expectPayment(issuer, 'A -> B transfer is allowed', A, B, true)

    step('Per-holder freeze: freeze A, then unfreeze')
    logTx('froze A', await issuer.freezeHolder(A))
    await expectPayment(issuer, 'A -> B while A frozen is rejected', A, B, false)
    await expectPayment(issuer, 'B -> A while A frozen is rejected', B, A, false)
    await reportLedger(issuer, 'issuer -> A while A frozen', issuer.issuer, A)
    await assert.rejects(issuer.issue(A, 1n), FrozenError)
    console.log('   ✓ module refuses to issue to frozen A')
    await expectPayment(issuer, 'B -> C unaffected by A freeze', B, C, true)
    logTx('unfroze A', await issuer.unfreezeHolder(A))
    await expectPayment(issuer, 'A -> B after unfreeze is allowed', A, B, true)

    step('Clawback: 300 from B')
    const claw = await issuer.clawback(B, 300n)
    assert.equal(claw.clawedBack, 300n)
    logTx(`clawed back ${claw.clawedBack} from B`, claw)

    step('Global freeze: freeze everything, then lift')
    logTx('froze all balances', await issuer.freezeAll())
    assert.equal((await issuer.getIssuanceStatus()).globallyFrozen, true)
    await expectPayment(issuer, 'A -> B during global freeze is rejected', A, B, false)
    await expectPayment(issuer, 'B -> C during global freeze is rejected', B, C, false)
    await reportLedger(issuer, 'issuer -> A during global freeze', issuer.issuer, A)
    await assert.rejects(issuer.issue(A, 1n), FrozenError)
    console.log('   ✓ module refuses to issue during global freeze')
    logTx('lifted global freeze', await issuer.unfreezeAll())
    await expectPayment(issuer, 'A -> B after global unfreeze is allowed', A, B, true)

    step('Per-holder freeze: freeze B (stays frozen)')
    logTx('froze B', await issuer.freezeHolder(B))
    await expectPayment(issuer, 'A -> B while B frozen is rejected', A, B, false)
    await expectPayment(issuer, 'B -> A while B frozen is rejected', B, A, false)
    await assert.rejects(issuer.issue(B, 1n), FrozenError)
    console.log('   ✓ module refuses to issue to frozen B')

    step('Ban C')
    const ban = await issuer.banHolder(C, 'Demo: sanctions screening hit')
    for (const s of ban.steps) logTx(`ban step: ${s.action}`, { hash: s.hash, ledgerIndex: undefined })
    assert.equal(ban.clawedBack, 250n)
    console.log(`   ✓ clawed back ${ban.clawedBack} from C; C balance now ${ban.finalStatus.balance}`)
    await expectPayment(issuer, 'issuer -> C after ban is rejected', issuer.issuer, C, false)
    await expectPayment(issuer, 'A -> C after ban is rejected', A, C, false)
    await assert.rejects(issuer.approveHolder(C), BannedHolderError)
    await assert.rejects(issuer.issue(C, 1n), BannedHolderError)
    console.log('   ✓ module refuses to re-approve or issue to C')

    step('Verify final ledger state')
    const final = await issuer.getIssuanceStatus()
    assert.equal(final.issuer, issuerWallet.classicAddress)
    assert.ok(final.requireAuth && final.canLock && final.canClawback && final.canTransfer, 'controls enabled')
    assert.equal(final.globallyFrozen, false)
    assert.equal(final.outstandingAmount, 1200n)
    const expected: Record<string, Omit<HolderStatus, 'address' | 'escrowed'>> = {
      A: { optedIn: true, approved: true, frozen: false, balance: 500n },
      B: { optedIn: true, approved: true, frozen: true, balance: 700n },
      C: { optedIn: true, approved: false, frozen: true, balance: 0n },
    }
    for (const [name, address] of Object.entries({ A, B, C })) {
      const { address: _, escrowed, ...actual } = await issuer.getHolderStatus(address)
      assert.equal(escrowed, 0n)
      assert.deepEqual(actual, expected[name], `holder ${name}`)
      console.log(`   ✓ ${name} ${address}: ${JSON.stringify(actual, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
    }
    assert.equal(await issuer.isBanned(C), true)
    console.log(`   ✓ issuance: outstanding=${final.outstandingAmount} globallyFrozen=${final.globallyFrozen}`)

    const result = { issuanceId: issuer.issuanceId, holders: { A, B, C } }
    await writeFile(resolve(ROOT, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    console.log('\nWrote result.json')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:', error)
  process.exitCode = 1
})
