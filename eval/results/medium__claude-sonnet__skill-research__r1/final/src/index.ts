import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  Client,
  Wallet,
  type SubmittableTransaction,
  type TxResponse,
  type MPTokenIssuanceCreate,
  type MPTokenAuthorize,
  type Payment,
} from 'xrpl'

const TESTNET_WS_URL = 'wss://s.altnet.rippletest.net:51233'

// Pre-funded testnet account that issues the MPT.
const ISSUER_ADDRESS = 'ra93qYvkRec8FncfEwJ3ee1KBm3KYTTUzt'
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>'

// XRP (in drops) sent from the issuer to activate the new holder account.
// Covers the 1 XRP base reserve, the 0.2 XRP owner reserve for its MPToken
// object, and transaction fees, with headroom to spare.
const HOLDER_FUNDING_DROPS = '5000000'

const TOKEN_MAXIMUM_AMOUNT = '1000000000'
const TOKEN_AMOUNT_TO_SEND = '1000'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULT_PATH = path.join(__dirname, '..', 'result.json')

interface ResultFile {
  issuanceId: string
  holder: string
  holderBalance: string
  outstandingAmount: string
}

/**
 * submitAndWait() resolves (rather than throws) for any transaction that
 * makes it into a validated ledger, including tec-class failures. Every
 * caller must inspect TransactionResult explicitly to catch those.
 */
async function submitAndVerify<T extends SubmittableTransaction>(
  client: Client,
  transaction: T,
  wallet: Wallet,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(transaction, { wallet })
  const meta = response.result.meta

  if (typeof meta !== 'object' || meta === null) {
    throw new Error(
      `${transaction.TransactionType}: no transaction metadata returned`,
    )
  }
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `${transaction.TransactionType} failed with ${meta.TransactionResult}`,
    )
  }

  return response
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WS_URL)
  await client.connect()

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED)
    if (issuerWallet.address !== ISSUER_ADDRESS) {
      throw new Error(
        `Issuer seed resolves to ${issuerWallet.address}, expected ${ISSUER_ADDRESS}`,
      )
    }
    console.log(`Issuer:  ${issuerWallet.address}`)

    // 2. Set up a second testnet account to act as the holder.
    const holderWallet = Wallet.generate()
    console.log(`Holder:  ${holderWallet.address}`)

    console.log('Funding holder account from issuer...')
    await submitAndVerify<Payment>(
      client,
      {
        TransactionType: 'Payment',
        Account: issuerWallet.address,
        Destination: holderWallet.address,
        Amount: HOLDER_FUNDING_DROPS,
      },
      issuerWallet,
    )

    // 1. Issue a new MPT. tfMPTRequireAuth restricts holding to accounts the
    // issuer explicitly approves (allow-listing).
    console.log('Creating MPT issuance...')
    const issuanceCreateResponse = await submitAndVerify<MPTokenIssuanceCreate>(
      client,
      {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: issuerWallet.address,
        AssetScale: 0,
        MaximumAmount: TOKEN_MAXIMUM_AMOUNT,
        Flags: {
          tfMPTRequireAuth: true,
        },
      },
      issuerWallet,
    )

    const issuanceCreateMeta = issuanceCreateResponse.result.meta
    if (typeof issuanceCreateMeta !== 'object' || issuanceCreateMeta === null) {
      throw new Error('MPTokenIssuanceCreate: no transaction metadata returned')
    }
    const issuanceId = issuanceCreateMeta.mpt_issuance_id
    if (!issuanceId) {
      throw new Error(
        'MPTokenIssuanceCreate: mpt_issuance_id missing from transaction metadata',
      )
    }
    console.log(`Issuance ID: ${issuanceId}`)

    // Holder opts in first (creates their MPToken object)...
    console.log('Holder opting in to the MPT...')
    await submitAndVerify<MPTokenAuthorize>(
      client,
      {
        TransactionType: 'MPTokenAuthorize',
        Account: holderWallet.address,
        MPTokenIssuanceID: issuanceId,
      },
      holderWallet,
    )

    // ...then the issuer approves that specific holder (allow-listing).
    console.log('Issuer approving holder...')
    await submitAndVerify<MPTokenAuthorize>(
      client,
      {
        TransactionType: 'MPTokenAuthorize',
        Account: issuerWallet.address,
        MPTokenIssuanceID: issuanceId,
        Holder: holderWallet.address,
      },
      issuerWallet,
    )

    // 3. Send the holder 1,000 of the token.
    console.log(`Sending ${TOKEN_AMOUNT_TO_SEND} tokens to holder...`)
    await submitAndVerify<Payment>(
      client,
      {
        TransactionType: 'Payment',
        Account: issuerWallet.address,
        Destination: holderWallet.address,
        Amount: {
          mpt_issuance_id: issuanceId,
          value: TOKEN_AMOUNT_TO_SEND,
        },
      },
      issuerWallet,
    )

    // 4. Read balances back from the ledger.
    console.log('Reading balances back from the ledger...')
    const holderObjects = await client.request({
      command: 'account_objects',
      account: holderWallet.address,
      type: 'mptoken',
      ledger_index: 'validated',
    })
    const holderMPToken = holderObjects.result.account_objects.find(
      (obj): obj is typeof obj & { MPTokenIssuanceID: string; MPTAmount: string } =>
        'MPTokenIssuanceID' in obj && obj.MPTokenIssuanceID === issuanceId,
    )
    if (!holderMPToken) {
      throw new Error('Could not find holder MPToken object on the ledger')
    }
    const holderBalance = holderMPToken.MPTAmount

    const issuerObjects = await client.request({
      command: 'account_objects',
      account: issuerWallet.address,
      type: 'mpt_issuance',
      ledger_index: 'validated',
    })
    const issuance = issuerObjects.result.account_objects.find(
      (
        obj,
      ): obj is typeof obj & {
        mpt_issuance_id: string
        OutstandingAmount: string
      } => 'mpt_issuance_id' in obj && obj.mpt_issuance_id === issuanceId,
    )
    if (!issuance) {
      throw new Error('Could not find MPTokenIssuance object on the ledger')
    }
    const outstandingAmount = issuance.OutstandingAmount

    console.log(`Holder balance:      ${holderBalance}`)
    console.log(`Outstanding amount:  ${outstandingAmount}`)

    const result: ResultFile = {
      issuanceId,
      holder: holderWallet.address,
      holderBalance,
      outstandingAmount,
    }
    await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`)
    console.log(`Wrote ${RESULT_PATH}`)
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
