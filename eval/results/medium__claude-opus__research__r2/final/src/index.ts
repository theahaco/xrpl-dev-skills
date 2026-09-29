// Issues a Multi-Purpose Token (MPT) on the XRPL testnet, authorizes a holder,
// pays the holder 1,000 units, and reads the balances back from the ledger.
import { writeFile } from 'node:fs/promises'
import {
  Client,
  RIPPLED_API_V2,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntry,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type SubmittableTransaction,
  type TxResponse,
} from 'xrpl'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const HOLDER_FUNDING_XRP = '5'
const PAYMENT_AMOUNT = '1000'
// Bit set on an MPToken entry once the issuer has authorized the holder.
const LSF_MPT_AUTHORIZED = 0x00000002

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  const code = typeof meta === 'object' ? meta.TransactionResult : 'unknown'
  if (code !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${code} (${response.result.hash})`)
  }
  console.log(`  ${tx.TransactionType} validated: ${response.result.hash}`)
  return response
}

async function main(): Promise<void> {
  const issuerSeed = process.env['XRPL_ISSUER_SEED']
  if (!issuerSeed) throw new Error('Set XRPL_ISSUER_SEED to the issuer account seed')

  // xrpl 5.x infers the key algorithm from the seed prefix (sEd... => ed25519).
  const issuer = Wallet.fromSeed(issuerSeed)
  const client = new Client(TESTNET_URL)
  await client.connect()

  try {
    console.log(`Issuer: ${issuer.classicAddress}`)

    // 1. Create the MPT issuance. tfMPTRequireAuth means only accounts the
    //    issuer explicitly authorizes can hold the token.
    console.log('Creating MPT issuance...')
    const created = await submit(client, issuer, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    })
    const createdMeta = created.result.meta
    const issuanceId = typeof createdMeta === 'object' ? createdMeta.mpt_issuance_id : undefined
    if (!issuanceId) throw new Error('No mpt_issuance_id in transaction metadata')
    console.log(`  Issuance ID: ${issuanceId}`)

    // 2. Create and fund the holder account from the issuer, then have the
    //    holder opt in and the issuer approve it.
    const holder = Wallet.generate()
    await writeFile(
      'holder-wallet.json',
      JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + '\n',
    )
    console.log(`Funding holder ${holder.classicAddress} with ${HOLDER_FUNDING_XRP} XRP...`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })

    console.log('Holder opts in to the MPT...')
    await submit(client, holder, {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    })

    console.log('Issuer authorizes the holder...')
    await submit(client, issuer, {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    })

    // 3. Send the holder 1,000 units.
    console.log(`Sending ${PAYMENT_AMOUNT} MPT to the holder...`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: PAYMENT_AMOUNT },
    })

    // 4. Read the balances back from the latest validated ledger.
    // xrpl 5.3.0 leaves MPToken out of its LedgerEntry union, so the response
    // types are given explicitly rather than cast.
    const issuanceEntry = await client.request<
      LedgerEntryRequest,
      typeof RIPPLED_API_V2,
      LedgerEntryResponse<LedgerEntry.MPTokenIssuance>
    >({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_index: 'validated' })
    const issuance = issuanceEntry.result.node
    if (!issuance) throw new Error('MPTokenIssuance entry not found')

    const tokenEntry = await client.request<
      LedgerEntryRequest,
      typeof RIPPLED_API_V2,
      LedgerEntryResponse<LedgerEntry.MPToken>
    >({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: 'validated',
    })
    const token = tokenEntry.result.node
    if (!token) throw new Error('MPToken entry not found')

    const holderBalance = token.MPTAmount ?? '0'
    const outstandingAmount = issuance.OutstandingAmount
    const authorized = (token.Flags & LSF_MPT_AUTHORIZED) !== 0

    console.log('\nRead back from the validated ledger:')
    console.log(`  Holder authorized:  ${authorized}`)
    console.log(`  Holder balance:     ${holderBalance}`)
    console.log(`  Outstanding amount: ${outstandingAmount}`)

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    }
    await writeFile('result.json', JSON.stringify(result, null, 2) + '\n')
    console.log('\nWrote result.json')
  } finally {
    await client.disconnect()
  }
}

await main()
