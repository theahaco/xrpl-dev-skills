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
const EXPECTED_ISSUER = 'rHXr7VwVqRBLjkpeUdKdZUALkyQGVWRHUZ'
// Base reserve (1 XRP) + one owner reserve for the MPToken entry (0.2 XRP) + headroom for fees.
const HOLDER_FUNDING_XRP = '5'
const AMOUNT_TO_SEND = '1000'

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
  label: string,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  const code = typeof meta === 'object' ? meta.TransactionResult : 'unknown'
  if (code !== 'tesSUCCESS') {
    throw new Error(`${label} failed: ${code} (tx ${response.result.hash})`)
  }
  console.log(`✔ ${label}: ${response.result.hash}`)
  return response
}

async function main(): Promise<void> {
  const seed = process.env['ISSUER_SEED']
  if (!seed) throw new Error('ISSUER_SEED is not set (see .env.example)')

  // xrpl.js 5.x infers the algorithm from the seed prefix; be explicit anyway.
  const issuer = Wallet.fromSeed(seed, { algorithm: ECDSA.ed25519 })
  if (issuer.classicAddress !== EXPECTED_ISSUER) {
    throw new Error(`Seed derives ${issuer.classicAddress}, expected ${EXPECTED_ISSUER}`)
  }

  const client = new Client(TESTNET_URL)
  await client.connect()
  try {
    // 1. Create the issuance. tfMPTRequireAuth means only holders the issuer
    //    has explicitly authorized can hold the token.
    const created = await submit(
      client,
      issuer,
      {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: issuer.classicAddress,
        AssetScale: 0,
        Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
      },
      'MPTokenIssuanceCreate',
    )
    const createdMeta = created.result.meta
    const issuanceId = typeof createdMeta === 'object' ? createdMeta.mpt_issuance_id : undefined
    if (!issuanceId) throw new Error('mpt_issuance_id missing from transaction metadata')
    console.log(`  Issuance ID: ${issuanceId}`)

    // 2a. Create and fund the holder account from the issuer.
    const holder = Wallet.generate(ECDSA.ed25519)
    console.log(`  Holder address: ${holder.classicAddress}`)
    console.log(`  Holder seed (testnet only): ${holder.seed}`)
    await submit(
      client,
      issuer,
      {
        TransactionType: 'Payment',
        Account: issuer.classicAddress,
        Destination: holder.classicAddress,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      },
      `Fund holder with ${HOLDER_FUNDING_XRP} XRP`,
    )

    // 2b. Holder opts in, creating its MPToken entry.
    await submit(
      client,
      holder,
      {
        TransactionType: 'MPTokenAuthorize',
        Account: holder.classicAddress,
        MPTokenIssuanceID: issuanceId,
      },
      'MPTokenAuthorize (holder opt-in)',
    )

    // 2c. Issuer approves the holder (sets lsfMPTAuthorized on the MPToken).
    await submit(
      client,
      issuer,
      {
        TransactionType: 'MPTokenAuthorize',
        Account: issuer.classicAddress,
        MPTokenIssuanceID: issuanceId,
        Holder: holder.classicAddress,
      },
      'MPTokenAuthorize (issuer approval)',
    )

    // 3. Send the holder the tokens.
    await submit(
      client,
      issuer,
      {
        TransactionType: 'Payment',
        Account: issuer.classicAddress,
        Destination: holder.classicAddress,
        Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
      },
      `Payment of ${AMOUNT_TO_SEND} MPT`,
    )

    // 4. Read balances back from the validated ledger.
    // xrpl.js 5.3.0's default LedgerEntry union omits MPToken, so type the response explicitly.
    const mptokenRequest: LedgerEntryRequest = {
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: 'validated',
    }
    const mptoken = await client.request<
      LedgerEntryRequest,
      2,
      LedgerEntryResponse<LedgerEntry.MPToken>
    >(mptokenRequest)
    const issuance = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    const tokenNode = mptoken.result.node
    const issuanceNode = issuance.result.node
    if (tokenNode?.LedgerEntryType !== 'MPToken') throw new Error('MPToken entry not found')
    if (issuanceNode?.LedgerEntryType !== 'MPTokenIssuance') {
      throw new Error('MPTokenIssuance entry not found')
    }

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance: tokenNode.MPTAmount,
      outstandingAmount: issuanceNode.OutstandingAmount,
    }
    console.log(`\nHolder balance:     ${result.holderBalance}`)
    console.log(`Outstanding amount: ${result.outstandingAmount}`)

    await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`)
    console.log('Wrote result.json')
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
