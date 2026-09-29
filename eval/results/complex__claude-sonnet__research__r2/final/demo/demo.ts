import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, Wallet, type Payment } from 'xrpl'
import { MptIssuer, optIntoMpt, submitAndCheck, submitAndReport } from '../src'

const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233'
const ISSUER_SEED = process.env.ISSUER_SEED ?? '<TESTNET_SEED_REDACTED>'
const HOLDER_FUNDING_XRP = '5000000' // 5 XRP in drops; covers account + MPToken reserve plus fees

function log(step: string, detail?: unknown): void {
  console.log(detail === undefined ? `\n== ${step} ==` : `${step}: ${JSON.stringify(detail)}`)
}

async function fundAccount(client: Client, issuer: Wallet, destination: string): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: issuer.address,
    Destination: destination,
    Amount: HOLDER_FUNDING_XRP,
  }
  await submitAndCheck(client, tx, issuer)
}

/** Submits a payment that we expect the ledger to reject, and reports the result code instead of throwing. Used only to demonstrate that a freeze/ban is actually enforced. */
async function attemptBlockedPayment(
  client: Client,
  from: Wallet,
  to: string,
  issuanceId: string,
  value: string,
): Promise<string> {
  const { code } = await submitAndReport(
    client,
    {
      TransactionType: 'Payment',
      Account: from.address,
      Destination: to,
      Amount: { mpt_issuance_id: issuanceId, value },
    },
    from,
  )
  return code
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WS)
  await client.connect()

  const issuerWallet = Wallet.fromSeed(ISSUER_SEED)
  const holderA = Wallet.generate()
  const holderB = Wallet.generate()
  const holderC = Wallet.generate()

  log('Issuer', issuerWallet.address)
  log('Holder A', holderA.address)
  log('Holder B', holderB.address)
  log('Holder C', holderC.address)

  log('Funding holder accounts from issuer')
  await fundAccount(client, issuerWallet, holderA.address)
  await fundAccount(client, issuerWallet, holderB.address)
  await fundAccount(client, issuerWallet, holderC.address)

  log('Issuing regulated stablecoin-style MPT')
  const issuer = await MptIssuer.issue(client, issuerWallet, {
    assetScale: 2,
    maximumAmount: '1000000000000',
    metadata: {
      ticker: 'RUSD',
      name: 'Regulated Test Dollar',
      desc: 'Testnet demo of a regulated stablecoin-style token with allowlist, clawback, freeze, and ban controls.',
      icon: 'https://example.com/rusd-icon.png',
      asset_class: 'rwa',
      asset_subclass: 'stablecoin',
      issuer_name: 'Wyndham Tech (testnet demo issuer)',
    },
  })
  log('Issuance created', issuer.issuanceId)

  log('Holders opt in (holder-side action) and issuer approves (allowlist)')
  for (const [name, holder] of [
    ['A', holderA],
    ['B', holderB],
    ['C', holderC],
  ] as const) {
    await optIntoMpt(client, holder, issuer.issuanceId)
    await issuer.approveHolder(holder.address)
    log(`Holder ${name} opted in and approved`)
  }

  log('Issuer distributes initial balances')
  await issuer.sendTo(holderA.address, '500')
  await issuer.sendTo(holderB.address, '1000')
  await issuer.sendTo(holderC.address, '200')
  log('A=500, B=1000, C=200')

  log('GLOBAL FREEZE: locking the entire token')
  await issuer.freezeGlobal()
  const blockedDuringGlobalFreeze = await attemptBlockedPayment(client, holderA, holderB.address, issuer.issuanceId, '10')
  log('A -> B payment while globally frozen (expected to fail)', blockedDuringGlobalFreeze)
  log('Lifting global freeze')
  await issuer.unfreezeGlobal()

  log('PER-HOLDER FREEZE: freezing A')
  await issuer.freezeHolder(holderA.address)
  const blockedSendFromFrozenA = await attemptBlockedPayment(client, holderA, holderB.address, issuer.issuanceId, '10')
  log('A -> B payment while A is frozen (expected to fail)', blockedSendFromFrozenA)
  const blockedReceiveIntoFrozenA = await attemptBlockedPayment(client, holderB, holderA.address, issuer.issuanceId, '10')
  log('B -> A payment while A is frozen (expected to fail)', blockedReceiveIntoFrozenA)
  log('Unfreezing A')
  await issuer.unfreezeHolder(holderA.address)

  log('CLAWBACK: clawing back 300 from B')
  await issuer.clawback(holderB.address, '300')
  log('B now holds 700')

  log('PER-HOLDER FREEZE: freezing B (left frozen at end of demo)')
  await issuer.freezeHolder(holderB.address)

  log('BAN: banning C')
  await issuer.ban(holderC.address)
  const blockedPaymentToC = await attemptBlockedPayment(client, issuerWallet, holderC.address, issuer.issuanceId, '5')
  log('Issuer -> C payment after ban (expected to fail)', blockedPaymentToC)
  log('C banned, holds 0, cannot receive again', { isBanned: issuer.isBanned(holderC.address) })

  log('Final on-ledger status')
  const statusA = await issuer.getHolderStatus(holderA.address)
  const statusB = await issuer.getHolderStatus(holderB.address)
  const statusC = await issuer.getHolderStatus(holderC.address)
  const issuanceStatus = await issuer.getIssuanceStatus()
  log('A', statusA)
  log('B', statusB)
  log('C', statusC)
  log('Issuance', issuanceStatus)

  const result = {
    issuanceId: issuer.issuanceId,
    holders: {
      A: holderA.address,
      B: holderB.address,
      C: holderC.address,
    },
  }
  const resultPath = join(__dirname, '..', 'result.json')
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n')
  log('Wrote result.json', resultPath)

  await client.disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
