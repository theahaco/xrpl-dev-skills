import {
  Client,
  Wallet,
  MPTokenIssuanceCreateFlags,
  LedgerEntry,
  type MPTokenIssuanceCreate,
  type MPTokenAuthorize,
  type Payment,
  type MPTAmount,
} from 'xrpl'
import { writeFileSync } from 'fs'
import { join } from 'path'

const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233'
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>'
const TOKEN_AMOUNT_TO_SEND = '1000'

async function getMptOutstandingAmount(
  client: Client,
  mptIssuanceId: string,
): Promise<string> {
  const response = await client.request({
    command: 'ledger_entry',
    mpt_issuance: mptIssuanceId,
    ledger_index: 'validated',
  })
  const node = response.result.node as unknown as LedgerEntry.MPTokenIssuance
  return node.OutstandingAmount
}

async function getMptHolderBalance(
  client: Client,
  mptIssuanceId: string,
  holderAddress: string,
): Promise<string> {
  const response = await client.request({
    command: 'ledger_entry',
    mptoken: {
      mpt_issuance_id: mptIssuanceId,
      account: holderAddress,
    },
    ledger_index: 'validated',
  })
  const node = response.result.node as unknown as LedgerEntry.MPToken
  return node.MPTAmount
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WS)
  await client.connect()

  try {
    const issuer = Wallet.fromSeed(ISSUER_SEED)
    console.log(`Issuer address: ${issuer.address}`)

    console.log('Funding a new holder account from the testnet faucet...')
    const { wallet: holder } = await client.fundWallet()
    console.log(`Holder address: ${holder.address}`)

    console.log('Creating the MPT issuance (RequireAuth enabled)...')
    const issuanceCreateTx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.address,
      AssetScale: 0,
      MaximumAmount: '1000000000',
      MPTokenMetadata: Buffer.from(
        JSON.stringify({ name: 'Test MPT', ticker: 'TMPT' }),
      ).toString('hex'),
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    }
    const issuanceCreateResult = await client.submitAndWait(issuanceCreateTx, {
      wallet: issuer,
    })
    const issuanceMeta = issuanceCreateResult.result.meta
    if (
      typeof issuanceMeta !== 'object' ||
      issuanceMeta.TransactionResult !== 'tesSUCCESS'
    ) {
      throw new Error(
        `MPTokenIssuanceCreate failed: ${JSON.stringify(issuanceCreateResult.result.meta)}`,
      )
    }
    const issuanceId = issuanceMeta.mpt_issuance_id
    if (!issuanceId) {
      throw new Error('MPT issuance ID missing from transaction metadata')
    }
    console.log(`MPT issuance ID: ${issuanceId}`)

    console.log('Holder opting in to hold the MPT...')
    const holderAuthorizeTx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.address,
      MPTokenIssuanceID: issuanceId,
    }
    const holderAuthorizeResult = await client.submitAndWait(
      holderAuthorizeTx,
      { wallet: holder },
    )
    if (
      typeof holderAuthorizeResult.result.meta !== 'object' ||
      holderAuthorizeResult.result.meta.TransactionResult !== 'tesSUCCESS'
    ) {
      throw new Error(
        `Holder MPTokenAuthorize failed: ${JSON.stringify(holderAuthorizeResult.result.meta)}`,
      )
    }

    console.log('Issuer approving the holder to hold the MPT...')
    const issuerAuthorizeTx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.address,
    }
    const issuerAuthorizeResult = await client.submitAndWait(
      issuerAuthorizeTx,
      { wallet: issuer },
    )
    if (
      typeof issuerAuthorizeResult.result.meta !== 'object' ||
      issuerAuthorizeResult.result.meta.TransactionResult !== 'tesSUCCESS'
    ) {
      throw new Error(
        `Issuer MPTokenAuthorize failed: ${JSON.stringify(issuerAuthorizeResult.result.meta)}`,
      )
    }

    console.log(`Sending ${TOKEN_AMOUNT_TO_SEND} MPT to the holder...`)
    const mptAmount: MPTAmount = {
      mpt_issuance_id: issuanceId,
      value: TOKEN_AMOUNT_TO_SEND,
    }
    const paymentTx: Payment = {
      TransactionType: 'Payment',
      Account: issuer.address,
      Destination: holder.address,
      Amount: mptAmount,
    }
    const paymentResult = await client.submitAndWait(paymentTx, {
      wallet: issuer,
    })
    if (
      typeof paymentResult.result.meta !== 'object' ||
      paymentResult.result.meta.TransactionResult !== 'tesSUCCESS'
    ) {
      throw new Error(
        `Payment failed: ${JSON.stringify(paymentResult.result.meta)}`,
      )
    }

    console.log('Reading balances back from the ledger...')
    const holderBalance = await getMptHolderBalance(
      client,
      issuanceId,
      holder.address,
    )
    const outstandingAmount = await getMptOutstandingAmount(client, issuanceId)

    console.log(`Holder balance: ${holderBalance}`)
    console.log(`Outstanding amount (total in circulation): ${outstandingAmount}`)

    const result = {
      issuanceId,
      holder: holder.address,
      holderBalance,
      outstandingAmount,
    }
    writeFileSync(
      join(__dirname, '..', 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
    )
    console.log('Wrote result.json')
  } finally {
    await client.disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
