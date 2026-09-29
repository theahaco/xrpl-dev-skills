import { writeFile } from 'node:fs/promises'
import {
  Client,
  ECDSA,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntry,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type Payment,
  type SubmittableTransaction,
  type TransactionMetadata,
} from 'xrpl'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const EXPECTED_ISSUER = 'rEbHDUKyMcrY81G8kzTbZwxumhemHSAaq3'
// Holder needs 1 XRP base reserve + 0.2 XRP for its MPToken entry, plus fees.
const HOLDER_FUNDING_XRP = '5'
const AMOUNT_TO_SEND = '1000'

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<{ hash: string; meta: TransactionMetadata<T> }> {
  const response = await client.submitAndWait<T>(tx, { wallet, autofill: true })
  const meta = response.result.meta
  if (typeof meta !== 'object' || meta.TransactionResult !== 'tesSUCCESS') {
    const code = typeof meta === 'object' ? meta.TransactionResult : 'unknown'
    throw new Error(`${tx.TransactionType} failed: ${code} (${response.result.hash})`)
  }
  console.log(`  ${tx.TransactionType} validated: ${response.result.hash}`)
  return { hash: response.result.hash, meta }
}

async function main(): Promise<void> {
  const seed = process.env['XRPL_ISSUER_SEED']
  if (!seed) throw new Error('Set XRPL_ISSUER_SEED (see .env)')

  // xrpl.js 5.x infers the algorithm from the seed prefix; be explicit for sEd… seeds.
  const issuer = Wallet.fromSeed(seed, { algorithm: ECDSA.ed25519 })
  if (issuer.classicAddress !== EXPECTED_ISSUER) {
    throw new Error(`Seed derives ${issuer.classicAddress}, expected ${EXPECTED_ISSUER}`)
  }

  const client = new Client(TESTNET_URL)
  await client.connect()
  try {
    // 1. Create the issuance. tfMPTRequireAuth means only issuer-approved
    //    holders can hold it; tfMPTCanTransfer lets approved holders send
    //    it to each other (recipients still must be approved).
    console.log(`Issuer ${issuer.classicAddress}: creating MPT issuance…`)
    const create = await submit<MPTokenIssuanceCreate>(client, issuer, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags:
        MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
    })
    const issuanceId = create.meta.mpt_issuance_id
    if (!issuanceId) throw new Error('mpt_issuance_id missing from metadata')
    console.log(`  Issuance ID: ${issuanceId}`)

    // 2a. Create and fund the holder account from the issuer.
    const holder = Wallet.generate(ECDSA.ed25519)
    await writeFile(
      'holder-wallet.json',
      JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + '\n',
    )
    console.log(`Funding holder ${holder.classicAddress} with ${HOLDER_FUNDING_XRP} XRP…`)
    await submit<Payment>(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })

    // 2b. Holder opts in, creating its MPToken entry.
    console.log('Holder opting in to the MPT…')
    await submit<MPTokenAuthorize>(client, holder, {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    })

    // 2c. Issuer approves the holder (allow-listing).
    console.log('Issuer approving the holder…')
    await submit<MPTokenAuthorize>(client, issuer, {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    })

    // 3. Send the holder 1,000 tokens.
    console.log(`Sending ${AMOUNT_TO_SEND} tokens to the holder…`)
    await submit<Payment>(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
    })

    // 4. Read balances back from the latest validated ledger.
    // xrpl.js's LedgerEntry union omits MPToken, so pass the response type explicitly.
    const mptoken = await client.request<
      LedgerEntryRequest,
      2,
      LedgerEntryResponse<LedgerEntry.MPToken>
    >({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: 'validated',
    })
    const issuance = await client.request<
      LedgerEntryRequest,
      2,
      LedgerEntryResponse<LedgerEntry.MPTokenIssuance>
    >({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    const holderEntry = mptoken.result.node
    const issuanceEntry = issuance.result.node
    if (
      holderEntry?.LedgerEntryType !== 'MPToken' ||
      issuanceEntry?.LedgerEntryType !== 'MPTokenIssuance'
    ) {
      throw new Error('Could not read ledger entries back')
    }

    // MPTAmount is omitted from JSON when it is zero.
    const holderBalance = holderEntry.MPTAmount ?? '0'
    const outstandingAmount = issuanceEntry.OutstandingAmount

    console.log(`\nHolder balance:     ${holderBalance}`)
    console.log(`Outstanding amount: ${outstandingAmount}`)

    const result = { issuanceId, holder: holder.classicAddress, holderBalance, outstandingAmount }
    await writeFile('result.json', JSON.stringify(result, null, 2) + '\n')
    console.log('Wrote result.json')
  } finally {
    await client.disconnect()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
