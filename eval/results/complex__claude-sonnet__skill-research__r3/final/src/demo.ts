/**
 * Demo: exercises every issuer-side compliance control of the MptIssuer
 * module against XRP Ledger testnet.
 *
 * Run with `npm run demo`. Writes ../result.json on success.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client, Wallet, encodeMPTokenMetadata, xrpToDrops, type Payment } from 'xrpl'

import { optIntoIssuance } from './holderActions.js'
import { MptIssuer, type HolderState } from './mptIssuer.js'
import { TransactionFailedError, submitAndVerify } from './txHelpers.js'

const TESTNET_WSS = 'wss://s.altnet.rippletest.net:51233'

// Testnet-only demo credentials. In production the issuer's key never lives
// in source -- inject it via a secret manager / env var, as the fallback here
// still allows.
const ISSUER_SEED = process.env.ISSUER_SEED ?? '<TESTNET_SEED_REDACTED>'

const ASSET_SCALE = 6
const MAXIMUM_SUPPLY = '1000000000' // 1 billion tokens, human-readable units
const HOLDER_FUNDING_XRP = '5'

const RESULT_PATH = fileURLToPath(new URL('../result.json', import.meta.url))

function logStep(message: string): void {
  console.log(`\n=== ${message} ===`)
}

function logInfo(message: string): void {
  console.log(`  ${message}`)
}

/** Runs an action expected to be rejected by a compliance control, and fails the demo if it unexpectedly succeeds. */
async function expectRejection(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof TransactionFailedError) {
      logInfo(`[correctly rejected] ${label} -> ${error.engineResult}`)
      return
    }
    throw error
  }
  throw new Error(`Compliance control did not hold: "${label}" was expected to fail but succeeded`)
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label} -- expected ${String(expected)}, got ${String(actual)}`)
  }
  logInfo(`[ok] ${label} = ${String(actual)}`)
}

async function sendBetweenHolders(
  client: Client,
  from: Wallet,
  to: Wallet,
  issuanceId: string,
  baseUnitsValue: string,
): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: from.address,
    Destination: to.address,
    Amount: { mpt_issuance_id: issuanceId, value: baseUnitsValue },
  }
  await submitAndVerify(client, from, tx)
}

async function fundAccount(
  client: Client,
  issuerWallet: Wallet,
  destination: string,
  amountXrp: string,
): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: issuerWallet.address,
    Destination: destination,
    Amount: xrpToDrops(amountXrp),
  }
  await submitAndVerify(client, issuerWallet, tx)
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WSS, { maxFeeXRP: '2' })
  await client.connect()
  logInfo(`Connected to ${TESTNET_WSS}`)

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED)
    const holderA = Wallet.generate()
    const holderB = Wallet.generate()
    const holderC = Wallet.generate()

    logStep('Setup: issuer and holder accounts')
    logInfo(`Issuer:  ${issuerWallet.address}`)
    logInfo(`Holder A: ${holderA.address}`)
    logInfo(`Holder B: ${holderB.address}`)
    logInfo(`Holder C: ${holderC.address}`)

    logStep('Funding holder accounts from the issuer')
    for (const holder of [holderA, holderB, holderC]) {
      await fundAccount(client, issuerWallet, holder.address, HOLDER_FUNDING_XRP)
      logInfo(`Funded ${holder.address} with ${HOLDER_FUNDING_XRP} XRP`)
    }

    const issuer = new MptIssuer(client, issuerWallet)

    logStep('Creating the MPT issuance')
    const metadataHex = encodeMPTokenMetadata({
      ticker: 'RUSD',
      name: 'Regulated Demo USD',
      desc: 'Issuer-controlled regulated stablecoin demo (testnet only).',
      icon: 'https://example.com/regulated-usd-icon.png',
      asset_class: 'rwa',
      asset_subclass: 'stablecoin',
      issuer_name: 'Demo Compliance Issuer',
    })
    const issuanceId = await issuer.createIssuance({
      assetScale: ASSET_SCALE,
      maximumAmount: MAXIMUM_SUPPLY,
      allowTransferBetweenHolders: true,
      metadataHex,
    })
    logInfo(`Issuance created: ${issuanceId}`)

    logStep('Allowlisting holders (opt-in + issuer approval)')
    for (const [label, holder] of [
      ['A', holderA],
      ['B', holderB],
      ['C', holderC],
    ] as const) {
      await optIntoIssuance(client, holder, issuanceId)
      await issuer.approveHolder(holder.address)
      logInfo(`Holder ${label} (${holder.address}) opted in and approved`)
    }

    logStep('Issuing initial balances')
    await issuer.sendTokens(holderA.address, '500')
    logInfo('Sent 500 to Holder A')
    await issuer.sendTokens(holderB.address, '1000')
    logInfo('Sent 1000 to Holder B')
    await issuer.sendTokens(holderC.address, '200')
    logInfo('Sent 200 to Holder C')

    logStep('Per-holder freeze: freezing and unfreezing Holder A')
    await issuer.freezeHolder(holderA.address)
    logInfo('Holder A frozen')

    // A lock blocks the holder from transacting with the rest of the token's
    // user base in either direction. (By protocol design the issuer itself
    // keeps a direct remediation channel to a locked holder -- e.g. to force
    // a corrective transfer or clawback -- the same "deep freeze" semantics
    // trust-line tokens have; that is not a gap in this compliance control.)
    await expectRejection('frozen Holder A -> Holder B payment', async () => {
      await sendBetweenHolders(client, holderA, holderB, issuanceId, '1000000')
    })
    await expectRejection('Holder B -> frozen Holder A payment', async () => {
      await sendBetweenHolders(client, holderB, holderA, issuanceId, '1000000')
    })

    await issuer.unfreezeHolder(holderA.address)
    logInfo('Holder A unfrozen')
    const holderAAfterUnfreeze = await issuer.getHolderState(holderA.address)
    assertEqual('Holder A balance unaffected by freeze/unfreeze', holderAAfterUnfreeze?.balance, '500')
    assertEqual('Holder A locked after unfreeze', holderAAfterUnfreeze?.locked, false)

    logStep('Global freeze: locking and unlocking the whole issuance')
    await issuer.globalFreeze()
    logInfo('Issuance globally locked')

    // As with an individual lock, a global lock halts movement between
    // holders; it does not touch the issuer's own remediation channel.
    await expectRejection('Holder A -> Holder C payment during global freeze', async () => {
      await sendBetweenHolders(client, holderA, holderC, issuanceId, '1000000')
    })

    await issuer.globalUnfreeze()
    logInfo('Issuance globally unlocked')
    const issuanceAfterGlobalUnfreeze = await issuer.getIssuanceState()
    assertEqual('Issuance globally locked after unfreeze', issuanceAfterGlobalUnfreeze.globallyLocked, false)

    logStep('Clawback: reclaiming 300 from Holder B, then leaving Holder B frozen')
    await issuer.clawback(holderB.address, '300')
    logInfo('Clawed back 300 from Holder B')
    await issuer.freezeHolder(holderB.address)
    logInfo('Holder B frozen (left frozen for final state)')

    logStep('Ban: Holder C loses its balance and can never receive the token again')
    const { clawedBack } = await issuer.banHolder(holderC.address)
    logInfo(`Banned Holder C (clawed back ${clawedBack})`)

    await expectRejection('issuer -> banned Holder C payment', async () => {
      await issuer.sendTokens(holderC.address, '50')
    })

    logStep('Final state verification')
    const finalA = await issuer.getHolderState(holderA.address)
    const finalB = await issuer.getHolderState(holderB.address)
    const finalC = await issuer.getHolderState(holderC.address)
    const finalIssuance = await issuer.getIssuanceState()

    printHolder('A', finalA)
    printHolder('B', finalB)
    printHolder('C', finalC)
    logInfo(
      `Issuance: outstanding=${finalIssuance.outstandingAmount} globallyLocked=${finalIssuance.globallyLocked}`,
    )

    assertEqual('Holder A balance', finalA?.balance, '500')
    assertEqual('Holder A locked', finalA?.locked, false)
    assertEqual('Holder A authorized', finalA?.authorized, true)

    assertEqual('Holder B balance', finalB?.balance, '700')
    assertEqual('Holder B locked', finalB?.locked, true)
    assertEqual('Holder B authorized', finalB?.authorized, true)

    assertEqual('Holder C balance', finalC?.balance, '0')
    assertEqual('Holder C locked', finalC?.locked, true)
    assertEqual('Holder C authorized', finalC?.authorized, false)

    assertEqual('Issuance globally locked', finalIssuance.globallyLocked, false)
    assertEqual('Issuance outstanding (500 + 700 + 0)', finalIssuance.outstandingAmount, '1200')

    const result = {
      issuanceId,
      holders: {
        A: holderA.address,
        B: holderB.address,
        C: holderC.address,
      },
    }
    writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`)
    logStep(`Wrote ${RESULT_PATH}`)

    console.log('\nDemo completed successfully.')
  } finally {
    await client.disconnect()
  }
}

function printHolder(label: string, state: HolderState | null): void {
  if (state === null) {
    logInfo(`Holder ${label}: not opted in`)
    return
  }
  logInfo(
    `Holder ${label}: balance=${state.balance} authorized=${state.authorized} locked=${state.locked}`,
  )
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:')
  console.error(error)
  process.exitCode = 1
})
