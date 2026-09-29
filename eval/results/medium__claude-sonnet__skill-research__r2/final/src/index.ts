import { writeFile } from 'node:fs/promises'

import {
  Client,
  Wallet,
  MPTokenIssuanceCreateFlags,
  LedgerEntry,
  type MPTokenIssuanceCreate,
  type MPTokenAuthorize,
  type Payment,
  type LedgerEntryResponse,
} from 'xrpl'

const TESTNET_WSS = 'wss://s.altnet.rippletest.net:51233'
const TESTNET_FAUCET_HOST = 'faucet.altnet.rippletest.net'

const ISSUER_SEED = '<TESTNET_SEED_REDACTED>'
const TOKEN_AMOUNT_TO_HOLDER = '1000'

async function main(): Promise<void> {
  const client = new Client(TESTNET_WSS)
  await client.connect()

  try {
    const issuer = Wallet.fromSeed(ISSUER_SEED)
    console.log(`Issuer: ${issuer.address}`)

    console.log('Funding a new holder account from the testnet faucet...')
    const { wallet: holder } = await client.fundWallet(undefined, {
      faucetHost: TESTNET_FAUCET_HOST,
    })
    console.log(`Holder: ${holder.address}`)

    console.log('Creating the MPT issuance (auth required)...')
    const issuanceId = await createMptIssuance(client, issuer)
    console.log(`MPTokenIssuanceID: ${issuanceId}`)

    console.log('Holder opts in to the MPT...')
    await holderOptsIn(client, holder, issuanceId)

    console.log('Issuer authorizes the holder...')
    await issuerAuthorizesHolder(client, issuer, holder.address, issuanceId)

    console.log(`Issuer sends ${TOKEN_AMOUNT_TO_HOLDER} MPT to the holder...`)
    await sendMpt(client, issuer, holder.address, issuanceId, TOKEN_AMOUNT_TO_HOLDER)

    console.log('Reading balances back from the ledger...')
    const holderBalance = await getHolderBalance(client, holder.address, issuanceId)
    const outstandingAmount = await getOutstandingAmount(client, issuanceId)

    console.log(`Holder balance: ${holderBalance}`)
    console.log(`Outstanding amount: ${outstandingAmount}`)

    const result = {
      issuanceId,
      holder: holder.address,
      holderBalance,
      outstandingAmount,
    }

    await writeFile(new URL('../result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
    console.log('Wrote result.json')
  } finally {
    await client.disconnect()
  }
}

async function createMptIssuance(client: Client, issuer: Wallet): Promise<string> {
  const tx: MPTokenIssuanceCreate = {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: issuer.address,
    AssetScale: 0,
    MaximumAmount: '9223372036854775807',
    Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
  }

  const prepared = await client.autofill(tx)
  const signed = issuer.sign(prepared)
  const response = await client.submitAndWait(signed.tx_blob)

  const meta = response.result.meta
  if (typeof meta !== 'object' || meta === null) {
    throw new Error('MPTokenIssuanceCreate did not return transaction metadata')
  }
  const result = (meta as { TransactionResult?: string }).TransactionResult
  if (result !== 'tesSUCCESS') {
    throw new Error(`MPTokenIssuanceCreate failed: ${result}`)
  }

  const issuanceId = (meta as { mpt_issuance_id?: string }).mpt_issuance_id
  if (issuanceId === undefined) {
    throw new Error('MPTokenIssuanceCreate metadata did not include mpt_issuance_id')
  }
  return issuanceId
}

async function holderOptsIn(client: Client, holder: Wallet, issuanceId: string): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holder.address,
    MPTokenIssuanceID: issuanceId,
  }
  await submitAndConfirm(client, holder, tx)
}

async function issuerAuthorizesHolder(
  client: Client,
  issuer: Wallet,
  holderAddress: string,
  issuanceId: string,
): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: issuer.address,
    MPTokenIssuanceID: issuanceId,
    Holder: holderAddress,
  }
  await submitAndConfirm(client, issuer, tx)
}

async function sendMpt(
  client: Client,
  issuer: Wallet,
  holderAddress: string,
  issuanceId: string,
  value: string,
): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: issuer.address,
    Destination: holderAddress,
    Amount: {
      mpt_issuance_id: issuanceId,
      value,
    },
  }
  await submitAndConfirm(client, issuer, tx)
}

async function submitAndConfirm(
  client: Client,
  wallet: Wallet,
  tx: MPTokenAuthorize | Payment,
): Promise<void> {
  const prepared = await client.autofill(tx)
  const signed = wallet.sign(prepared)
  const response = await client.submitAndWait(signed.tx_blob)

  const meta = response.result.meta
  const result =
    typeof meta === 'object' && meta !== null
      ? (meta as { TransactionResult?: string }).TransactionResult
      : undefined
  if (result !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${result ?? 'unknown result'}`)
  }
}

async function getHolderBalance(client: Client, holderAddress: string, issuanceId: string): Promise<string> {
  const response: LedgerEntryResponse<LedgerEntry.MPToken> = await client.request({
    command: 'ledger_entry',
    mptoken: {
      mpt_issuance_id: issuanceId,
      account: holderAddress,
    },
    ledger_index: 'validated',
  })

  if (response.result.node === undefined) {
    throw new Error('MPToken object not found for holder')
  }
  return response.result.node.MPTAmount
}

async function getOutstandingAmount(client: Client, issuanceId: string): Promise<string> {
  const response: LedgerEntryResponse<LedgerEntry.MPTokenIssuance> = await client.request({
    command: 'ledger_entry',
    mpt_issuance: issuanceId,
    ledger_index: 'validated',
  })

  if (response.result.node === undefined) {
    throw new Error('MPTokenIssuance object not found')
  }
  return response.result.node.OutstandingAmount
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
