import { writeFile } from 'node:fs/promises'
import {
  Client,
  LedgerEntry,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntryResponse,
  type SubmittableTransaction,
  type TxResponse,
} from 'xrpl'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const HOLDER_FUNDING_XRP = '10'
const PAYMENT_AMOUNT = '1000'

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  const code = typeof meta === 'object' ? meta.TransactionResult : undefined
  if (code !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${code ?? 'no metadata'}`)
  }
  console.log(`  ${tx.TransactionType} ✔ ${response.result.hash}`)
  return response
}

async function main(): Promise<void> {
  const issuerSeed = process.env.ISSUER_SEED
  if (!issuerSeed) {
    throw new Error('ISSUER_SEED is not set (see .env.example)')
  }
  const issuer = Wallet.fromSeed(issuerSeed)

  const client = new Client(TESTNET_URL)
  await client.connect()
  try {
    console.log(`Issuer: ${issuer.classicAddress}`)

    // 1. Issue the MPT. tfMPTRequireAuth means only issuer-approved holders can hold it.
    console.log('Creating MPT issuance...')
    const created = await submit(client, issuer, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.classicAddress,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    })
    const createMeta = created.result.meta
    const issuanceId =
      typeof createMeta === 'object' ? createMeta.mpt_issuance_id : undefined
    if (!issuanceId) {
      throw new Error('MPTokenIssuanceCreate metadata has no mpt_issuance_id')
    }
    console.log(`  Issuance ID: ${issuanceId}`)

    // 2. Create a holder account, funded from the issuer.
    const holder = Wallet.generate()
    console.log(`Funding holder ${holder.classicAddress}...`)
    console.log(`  Holder seed (testnet only): ${holder.seed}`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })

    // The holder opts in to the token (creates its MPToken entry)...
    console.log('Holder opting in...')
    await submit(client, holder, {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    })

    // ...and the issuer approves that holder.
    console.log('Issuer approving holder...')
    await submit(client, issuer, {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    })

    // 3. Send the holder 1,000 of the token.
    console.log(`Sending ${PAYMENT_AMOUNT} to holder...`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: PAYMENT_AMOUNT },
    })

    // 4. Read balances back from the validated ledger.
    const tokenResponse: LedgerEntryResponse<LedgerEntry.MPToken> =
      await client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
        ledger_index: 'validated',
      })
    const issuanceResponse: LedgerEntryResponse<LedgerEntry.MPTokenIssuance> =
      await client.request({
        command: 'ledger_entry',
        mpt_issuance: issuanceId,
        ledger_index: 'validated',
      })
    const token = tokenResponse.result.node
    const issuance = issuanceResponse.result.node
    if (!token || !issuance) {
      throw new Error('ledger_entry returned no node')
    }

    const requireAuth = LedgerEntry.MPTokenIssuanceFlags.lsfMPTRequireAuth
    if ((issuance.Flags & requireAuth) === 0) {
      throw new Error('Issuance on ledger does not have lsfMPTRequireAuth set')
    }

    // MPTAmount is a default field and is omitted from the entry when zero.
    const holderBalance = token.MPTAmount ?? '0'
    const outstandingAmount = issuance.OutstandingAmount

    console.log(`Holder balance:     ${holderBalance}`)
    console.log(`Outstanding amount: ${outstandingAmount}`)

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

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
