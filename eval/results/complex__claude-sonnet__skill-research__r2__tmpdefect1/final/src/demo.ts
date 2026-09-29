/**
 * End-to-end demo of the regulated MPT issuer module against XRPL testnet.
 *
 * Exercises every compliance control in src/mptIssuer.ts using the provided
 * issuer account and three freshly generated holder accounts (A, B, C),
 * then writes result.json with the issuance ID and holder addresses.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { Client, Wallet, xrpToDrops, type Payment } from 'xrpl'

import { MptComplianceIssuer, optInToIssuance } from './mptIssuer'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>'
const HOLDER_FUNDING_XRP = '5'

function log(step: string, detail: string): void {
  // eslint-disable-next-line no-console -- demo script output
  console.log(`[${step}] ${detail}`)
}

async function fundAccount(client: Client, issuer: Wallet, destination: string): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: issuer.address,
    Destination: destination,
    Amount: xrpToDrops(HOLDER_FUNDING_XRP),
  }
  const response = await client.submitAndWait(tx, { wallet: issuer, autofill: true })
  const meta = response.result.meta
  if (meta == null || typeof meta === 'string' || meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Funding payment to ${destination} failed`)
  }
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL)
  await client.connect()
  log('connect', `connected to ${TESTNET_URL}`)

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED)
    log('issuer', `using issuer account ${issuerWallet.address}`)

    const holderA = Wallet.generate()
    const holderB = Wallet.generate()
    const holderC = Wallet.generate()
    log('holders', `generated holder A=${holderA.address} B=${holderB.address} C=${holderC.address}`)

    for (const [label, holder] of [
      ['A', holderA],
      ['B', holderB],
      ['C', holderC],
    ] as const) {
      await fundAccount(client, issuerWallet, holder.address)
      log('fund', `sent ${HOLDER_FUNDING_XRP} XRP from issuer to holder ${label} (${holder.address})`)
    }

    const issuer = new MptComplianceIssuer(client, issuerWallet)
    const issuanceId = await issuer.createIssuance({
      assetScale: 0,
      maximumAmount: '1000000000',
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated Demo Stablecoin',
        desc: 'Demo of issuer-side compliance controls for a regulated MPT stablecoin.',
        icon: 'example.org/token-icon.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Wyndham Tech (testnet demo)',
      },
    })
    log('create-issuance', `created MPT issuance ${issuanceId}`)

    // --- Allowlist: approve A, B, and C after "KYC" ---
    for (const [label, holder] of [
      ['A', holderA],
      ['B', holderB],
      ['C', holderC],
    ] as const) {
      await optInToIssuance(client, holder, issuanceId)
      await issuer.authorizeHolder(holder.address)
      log('allowlist', `holder ${label} (${holder.address}) opted in and was authorized`)
    }

    // --- Distribute tokens ---
    await issuer.issue(holderA.address, '500')
    log('issue', 'sent 500 to holder A')

    await issuer.issue(holderB.address, '1000')
    log('issue', 'sent 1000 to holder B')

    await issuer.issue(holderC.address, '250')
    log('issue', 'sent 250 to holder C')

    // --- Per-holder freeze: freeze then unfreeze holder A ---
    await issuer.freezeHolder(holderA.address)
    log('freeze', 'holder A frozen')
    let stateA = await issuer.getHolderState(holderA.address)
    if (!stateA.locked) {
      throw new Error('Expected holder A to be locked after freezeHolder')
    }

    await issuer.unfreezeHolder(holderA.address)
    log('unfreeze', 'holder A unfrozen')
    stateA = await issuer.getHolderState(holderA.address)
    if (stateA.locked) {
      throw new Error('Expected holder A to be unlocked after unfreezeHolder')
    }

    // --- Global freeze: freeze then unfreeze the whole token ---
    await issuer.globalFreeze()
    log('global-freeze', 'token globally frozen')
    let issuanceState = await issuer.getIssuanceState()
    if (!issuanceState.globallyLocked) {
      throw new Error('Expected issuance to be globally locked after globalFreeze')
    }

    await issuer.globalUnfreeze()
    log('global-unfreeze', 'global freeze lifted')
    issuanceState = await issuer.getIssuanceState()
    if (issuanceState.globallyLocked) {
      throw new Error('Expected issuance to not be globally locked after globalUnfreeze')
    }

    // --- Clawback: claw back 300 from holder B, leaving 700 ---
    await issuer.clawback(holderB.address, '300')
    log('clawback', 'clawed back 300 from holder B')

    // Holder B ends the demo frozen.
    await issuer.freezeHolder(holderB.address)
    log('freeze', 'holder B frozen (left frozen at end of demo)')

    // --- Ban holder C: claws back remaining balance, freezes, de-authorizes ---
    await issuer.banHolder(holderC.address)
    log('ban', 'holder C banned (clawed back, frozen, and removed from allowlist)')

    // --- Final verification against the required end state ---
    const finalA = await issuer.getHolderState(holderA.address)
    const finalB = await issuer.getHolderState(holderB.address)
    const finalC = await issuer.getHolderState(holderC.address)
    const finalIssuance = await issuer.getIssuanceState()

    const checks: Array<[string, boolean]> = [
      ['A balance == 500', finalA.balance === '500'],
      ['A not locked', !finalA.locked],
      ['A authorized', finalA.authorized],
      ['B balance == 700', finalB.balance === '700'],
      ['B locked', finalB.locked],
      ['C balance == 0', finalC.balance === '0'],
      ['C not authorized', !finalC.authorized],
      ['C locked', finalC.locked],
      ['issuance not globally locked', !finalIssuance.globallyLocked],
      ['issuance requireAuth enabled', finalIssuance.requireAuth],
      ['issuance canClawback enabled', finalIssuance.canClawback],
    ]
    const failed = checks.filter(([, ok]) => !ok)
    if (failed.length > 0) {
      throw new Error(`Final state verification failed: ${failed.map(([name]) => name).join(', ')}`)
    }
    log('verify', 'final ledger state matches all required compliance outcomes')

    // Confirm holder C truly cannot receive the token again: authorizing a
    // banned holder was intentionally skipped, so a payment to them must fail
    // with tecNO_AUTH under RequireAuth. We don't attempt the payment here to
    // avoid burning a transaction on an expected failure; the unauthorized +
    // locked state checked above is what RequireAuth/CanLock enforce.

    const result = {
      issuanceId,
      holders: {
        A: holderA.address,
        B: holderB.address,
        C: holderC.address,
      },
    }
    const resultPath = path.join(__dirname, '..', 'result.json')
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    log('result', `wrote ${resultPath}`)
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- demo script output
  console.error(error)
  process.exitCode = 1
})
