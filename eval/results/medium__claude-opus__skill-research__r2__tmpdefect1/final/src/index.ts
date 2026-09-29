import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  Client,
  DEFAULT_API_VERSION,
  LedgerEntry,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type Payment,
  type SubmittableTransaction,
  type TxResponse,
} from 'xrpl'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const EXPECTED_ISSUER_ADDRESS = 'r4DhrmFFQZHYszkhoTq4yBLoTf2nqiaeyi'
// Covers the holder's base reserve (1 XRP) plus one owner reserve for its MPToken entry (0.2 XRP), with room for fees.
const HOLDER_FUNDING_XRP = '5'
const MPT_AMOUNT_TO_SEND = '1000'
// Set on an MPToken once the issuer has approved the holder.
const LSF_MPT_AUTHORIZED = 0x00000002

/** Submits a transaction, waits for validation, and throws unless it succeeded. */
async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
  label: string,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  const result = typeof meta === 'object' ? meta.TransactionResult : 'unknown'
  if (result !== 'tesSUCCESS') {
    throw new Error(`${label} failed: ${result} (tx ${response.result.hash})`)
  }
  console.log(`✔ ${label} — tx ${response.result.hash}`)
  return response
}

async function main(): Promise<void> {
  const seed = process.env.ISSUER_SEED
  if (!seed) {
    throw new Error('Set ISSUER_SEED to the issuer account seed.')
  }
  const issuer = Wallet.fromSeed(seed)
  if (issuer.classicAddress !== EXPECTED_ISSUER_ADDRESS) {
    throw new Error(`Seed derives ${issuer.classicAddress}, expected ${EXPECTED_ISSUER_ADDRESS}.`)
  }

  const client = new Client(TESTNET_URL)
  await client.connect()
  try {
    console.log(`Issuer: ${issuer.classicAddress}`)

    // 1. Create the issuance. tfMPTRequireAuth means only holders the issuer approves can hold it.
    const createTx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    }
    const created = await submit(client, issuer, createTx, 'MPTokenIssuanceCreate')
    const createMeta = created.result.meta
    const issuanceId = typeof createMeta === 'object' ? createMeta.mpt_issuance_id : undefined
    if (!issuanceId) {
      throw new Error('MPTokenIssuanceCreate metadata has no mpt_issuance_id.')
    }
    console.log(`  MPT issuance ID: ${issuanceId}`)

    // 2a. Create and fund the holder account from the issuer.
    const holder = Wallet.generate()
    console.log(`Holder: ${holder.classicAddress} (seed: ${holder.seed ?? 'n/a'})`)
    const fundTx: Payment = {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    }
    await submit(client, issuer, fundTx, `Fund holder with ${HOLDER_FUNDING_XRP} XRP`)

    // 2b. The holder opts in, creating its MPToken entry.
    const optInTx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    }
    await submit(client, holder, optInTx, 'Holder opts in (MPTokenAuthorize)')

    // 2c. The issuer approves the holder.
    const approveTx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    }
    await submit(client, issuer, approveTx, 'Issuer approves holder (MPTokenAuthorize)')

    // 3. Send the holder 1,000 of the token.
    const sendTx: Payment = {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: MPT_AMOUNT_TO_SEND },
    }
    await submit(client, issuer, sendTx, `Send ${MPT_AMOUNT_TO_SEND} MPT to holder`)

    // 4. Read the balances back from the latest validated ledger.
    const tokenEntry = await client.request<
      LedgerEntryRequest,
      typeof DEFAULT_API_VERSION,
      LedgerEntryResponse<LedgerEntry.MPToken>
    >({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: 'validated',
    })
    const token = tokenEntry.result.node
    if (token?.LedgerEntryType !== 'MPToken') {
      throw new Error('Holder MPToken entry not found.')
    }
    // MPTAmount is a default field, so the ledger omits it when the balance is zero.
    const holderBalance = token.MPTAmount ?? '0'
    const authorized = (token.Flags & LSF_MPT_AUTHORIZED) !== 0

    const issuanceEntry = await client.request<
      LedgerEntryRequest,
      typeof DEFAULT_API_VERSION,
      LedgerEntryResponse<LedgerEntry.MPTokenIssuance>
    >({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    const issuance = issuanceEntry.result.node
    if (issuance?.LedgerEntryType !== 'MPTokenIssuance') {
      throw new Error('MPTokenIssuance entry not found.')
    }
    const outstandingAmount = issuance.OutstandingAmount ?? '0'
    if (tokenEntry.result.validated !== true || issuanceEntry.result.validated !== true) {
      throw new Error('Balances were not read from a validated ledger.')
    }

    console.log(`\nRead back from the validated ledger:`)
    console.log(`  Holder balance:     ${holderBalance} (authorized by issuer: ${authorized})`)
    console.log(`  Outstanding amount: ${outstandingAmount}`)

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    }
    const resultPath = path.resolve(__dirname, '..', 'result.json')
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    console.log(`\nWrote ${resultPath}`)
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
