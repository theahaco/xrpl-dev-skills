/**
 * End-to-end demo of the MPT compliance issuer module against XRP Ledger
 * testnet. Creates a regulated MPT issuance from the issuer account, brings
 * up three holders (A, B, C), and exercises every compliance control:
 * allowlisting, per-holder freeze/unfreeze, global freeze/unfreeze,
 * clawback, and a full ban. Writes the resulting issuance ID and holder
 * addresses to result.json.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client, Wallet, xrpToDrops, type Payment } from 'xrpl'

import { MptComplianceIssuer } from './src/mptIssuer.js'
import { optInToIssuance } from './src/holder.js'
import { submitAndVerify, TransactionFailedError } from './src/txSubmit.js'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'

// Testnet-only account, provided for this task. Never hardcode a mainnet
// seed like this; use a secret manager or environment variable instead.
const ISSUER_SEED = process.env.ISSUER_SEED ?? '<TESTNET_SEED_REDACTED>'
const EXPECTED_ISSUER_ADDRESS = 'rKfPeXqFBEpSTwHZtgaxFUTFtg7ZEQN1he'

const HOLDER_FUNDING_XRP = '15'

function log(message: string): void {
  // eslint-disable-next-line no-console -- demo script output
  console.log(message)
}

/**
 * Runs an action that is expected to fail because a compliance control is
 * blocking it, and logs the outcome. Throws if the action unexpectedly
 * succeeds, since that would mean the control did not work.
 */
async function expectBlocked(description: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    const detail = error instanceof TransactionFailedError ? error.resultCode : String(error)
    log(`  blocked as expected: ${description} -> ${detail}`)
    return
  }
  throw new Error(`Expected "${description}" to be blocked, but it succeeded.`)
}

async function fundAccount(client: Client, funder: Wallet, destination: string): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: funder.classicAddress,
    Destination: destination,
    Amount: xrpToDrops(HOLDER_FUNDING_XRP),
  }
  await submitAndVerify(client, funder, tx)
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL)
  await client.connect()
  log(`Connected to ${TESTNET_URL}`)

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED)
    if (issuerWallet.classicAddress !== EXPECTED_ISSUER_ADDRESS) {
      throw new Error(
        `Issuer seed does not match expected address. Got ${issuerWallet.classicAddress}, expected ${EXPECTED_ISSUER_ADDRESS}.`,
      )
    }
    log(`Issuer: ${issuerWallet.classicAddress}`)

    const holderA = Wallet.generate()
    const holderB = Wallet.generate()
    const holderC = Wallet.generate()
    log(`Holder A: ${holderA.classicAddress}`)
    log(`Holder B: ${holderB.classicAddress}`)
    log(`Holder C: ${holderC.classicAddress}`)

    log(`\nFunding holders with ${HOLDER_FUNDING_XRP} XRP each from the issuer...`)
    await fundAccount(client, issuerWallet, holderA.classicAddress)
    await fundAccount(client, issuerWallet, holderB.classicAddress)
    await fundAccount(client, issuerWallet, holderC.classicAddress)
    log('Holders funded.')

    log('\nCreating MPT issuance (allowlist + freeze + clawback enabled)...')
    const issuer = MptComplianceIssuer.forNewIssuance(client, issuerWallet)
    const issuanceId = await issuer.createIssuance({
      assetScale: 0,
      maximumAmount: '1000000000',
    })
    log(`Issuance created: ${issuanceId}`)

    log('\nOpting in and allowlisting holders A, B, C...')
    for (const [label, wallet] of [
      ['A', holderA],
      ['B', holderB],
      ['C', holderC],
    ] as const) {
      await optInToIssuance(client, wallet, issuanceId)
      await issuer.approveHolder(wallet.classicAddress)
      log(`  holder ${label} opted in and approved`)
    }

    log('\nIssuing initial balances...')
    await issuer.send(holderA.classicAddress, '500')
    log('  sent 500 to A')
    await issuer.send(holderB.classicAddress, '1000')
    log('  sent 1000 to B')
    await issuer.send(holderC.classicAddress, '250')
    log('  sent 250 to C')

    log('\nExercising per-holder freeze on A...')
    await issuer.freezeHolder(holderA.classicAddress)
    log('  A frozen')
    await expectBlocked('payment to frozen holder A', () =>
      issuer.send(holderA.classicAddress, '1'),
    )
    await issuer.unfreezeHolder(holderA.classicAddress)
    log('  A unfrozen')

    log('\nExercising global freeze...')
    await issuer.globalFreeze()
    log('  token globally frozen')
    await expectBlocked('payment while globally frozen', () =>
      issuer.send(holderB.classicAddress, '1'),
    )
    await issuer.globalUnfreeze()
    log('  global freeze lifted')

    log('\nClawing back 300 from B...')
    await issuer.clawback(holderB.classicAddress, '300')
    log('  clawed back 300 from B (holds 700)')

    log('\nFreezing B (left frozen at end of demo)...')
    await issuer.freezeHolder(holderB.classicAddress)
    log('  B frozen')

    log('\nBanning C...')
    await issuer.banHolder(holderC.classicAddress)
    log('  C banned: balance clawed back and authorization revoked')
    await expectBlocked('payment to banned holder C', () =>
      issuer.send(holderC.classicAddress, '1'),
    )

    log('\nFinal state:')
    const [stateA, stateB, stateC, issuanceState] = await Promise.all([
      issuer.getHolderState(holderA.classicAddress),
      issuer.getHolderState(holderB.classicAddress),
      issuer.getHolderState(holderC.classicAddress),
      issuer.getIssuanceState(),
    ])
    log(`  A: balance=${stateA.balance} locked=${stateA.locked} authorized=${stateA.authorized}`)
    log(`  B: balance=${stateB.balance} locked=${stateB.locked} authorized=${stateB.authorized}`)
    log(`  C: balance=${stateC.balance} locked=${stateC.locked} authorized=${stateC.authorized}`)
    log(`  issuance globalLocked=${issuanceState.globalLocked} outstanding=${issuanceState.outstandingAmount}`)

    assertEqual('A balance', stateA.balance, '500')
    assertEqual('A locked', stateA.locked, false)
    assertEqual('B balance', stateB.balance, '700')
    assertEqual('B locked', stateB.locked, true)
    assertEqual('C balance', stateC.balance, '0')
    assertEqual('C authorized', stateC.authorized, false)
    assertEqual('issuance globalLocked', issuanceState.globalLocked, false)

    const result = {
      issuanceId,
      holders: {
        A: holderA.classicAddress,
        B: holderB.classicAddress,
        C: holderC.classicAddress,
      },
    }
    const resultPath = fileURLToPath(new URL('./result.json', import.meta.url))
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    log(`\nWrote ${resultPath}`)
  } finally {
    await client.disconnect()
  }
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label} expected ${String(expected)}, got ${String(actual)}`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
