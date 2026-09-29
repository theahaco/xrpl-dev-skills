import { writeFile } from 'node:fs/promises'

import {
  Client,
  ECDSA,
  LedgerEntry,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type SubmittableTransaction,
  type TxResponse,
} from 'xrpl'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const API_VERSION = 2

// XRP sent from the issuer to create and fund the holder account. The testnet
// reserve is 1 XRP base + 0.2 XRP per owned object (the holder's MPToken entry).
const HOLDER_FUNDING_XRP = '10'
const AMOUNT_TO_SEND = '1000'

// MPToken ledger entry flag (xrpl.js does not export an enum for it).
// https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken#mptoken-flags
const lsfMPTAuthorized = 0x00000002

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<TxResponse> {
  const response = await client.submitAndWait(tx, { autofill: true, wallet })
  const meta = response.result.meta
  const result =
    typeof meta === 'object' && meta !== null ? meta.TransactionResult : 'unknown'
  if (result !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${result} (${response.result.hash})`)
  }
  console.log(`  ${tx.TransactionType} ${result} ${response.result.hash}`)
  return response
}

function issuanceIdFrom(response: TxResponse): string {
  const meta: unknown = response.result.meta
  if (
    typeof meta === 'object' &&
    meta !== null &&
    'mpt_issuance_id' in meta &&
    typeof meta.mpt_issuance_id === 'string'
  ) {
    return meta.mpt_issuance_id
  }
  throw new Error('MPTokenIssuanceCreate metadata has no mpt_issuance_id')
}

async function getLedgerEntry<T extends { LedgerEntryType: string }>(
  client: Client,
  request: LedgerEntryRequest,
  type: T['LedgerEntryType'],
): Promise<T> {
  const response = await client.request<
    LedgerEntryRequest,
    typeof API_VERSION,
    LedgerEntryResponse<T>
  >(request)
  const node = response.result.node
  if (node?.LedgerEntryType !== type) {
    throw new Error(`ledger_entry did not return a ${type} entry`)
  }
  return node
}

async function main(): Promise<void> {
  const issuer = Wallet.fromSeed(requireEnv('ISSUER_SEED'), {
    algorithm: ECDSA.ed25519,
  })
  const expectedAddress = process.env['ISSUER_ADDRESS']
  if (expectedAddress !== undefined && expectedAddress !== issuer.classicAddress) {
    throw new Error(
      `Seed derives ${issuer.classicAddress}, expected ${expectedAddress}`,
    )
  }

  const client = new Client(TESTNET_URL)
  await client.connect()
  try {
    console.log(`Issuer: ${issuer.classicAddress}`)

    // 1. Create the MPT issuance. tfMPTRequireAuth means only holders the
    //    issuer has explicitly authorized can hold the token.
    console.log('Creating MPT issuance...')
    const createResponse = await submit(client, issuer, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    })
    const issuanceId = issuanceIdFrom(createResponse)
    console.log(`  Issuance ID: ${issuanceId}`)

    // 2a. Create the holder account by sending it XRP from the issuer.
    const holder = Wallet.generate(ECDSA.ed25519)
    console.log(`Funding holder ${holder.classicAddress}...`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })

    // 2b. The holder opts in, creating its (empty) MPToken entry.
    console.log('Holder opting in to the MPT...')
    await submit(client, holder, {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    })

    // 2c. The issuer approves the holder (required because of tfMPTRequireAuth).
    console.log('Issuer authorizing the holder...')
    await submit(client, issuer, {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    })

    // 3. Send the holder the tokens.
    console.log(`Sending ${AMOUNT_TO_SEND} tokens to the holder...`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
    })

    // 4. Read the balances back from the latest validated ledger.
    const mptoken = await getLedgerEntry<LedgerEntry.MPToken>(
      client,
      {
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
        ledger_index: 'validated',
      },
      'MPToken',
    )
    const issuance = await getLedgerEntry<LedgerEntry.MPTokenIssuance>(
      client,
      { command: 'ledger_entry', mpt_issuance: issuanceId, ledger_index: 'validated' },
      'MPTokenIssuance',
    )

    if ((issuance.Flags & LedgerEntry.MPTokenIssuanceFlags.lsfMPTRequireAuth) === 0) {
      throw new Error('Issuance does not have lsfMPTRequireAuth set')
    }
    if ((mptoken.Flags & lsfMPTAuthorized) === 0) {
      throw new Error('Holder MPToken does not have lsfMPTAuthorized set')
    }

    // Zero-valued amounts are omitted from ledger entries.
    const holderBalance = mptoken.MPTAmount ?? '0'
    const outstandingAmount = issuance.OutstandingAmount ?? '0'

    console.log(`Holder balance:     ${holderBalance}`)
    console.log(`Outstanding amount: ${outstandingAmount}`)
    console.log(`Holder seed (testnet only, not saved): ${holder.seed ?? ''}`)

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    }
    await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`)
    console.log('Wrote result.json')
  } finally {
    await client.disconnect()
  }
}

await main()
