import { readFile, writeFile } from 'node:fs/promises';
import {
  Client, Wallet, MPTokenIssuanceCreateFlags,
  xrpToDrops, type SubmittableTransaction,
} from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rhourKNgQvkTMr268W2rMBXdt3YiBBCZxf';
const client = new Client(endpoint);

async function submit<T extends SubmittableTransaction>(tx: T, wallet: Wallet) {
  const response = await client.submitAndWait(tx, { wallet, autofill: true });
  const { meta, validated, hash } = response.result;
  if (!validated || !meta || typeof meta === 'string' || meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${JSON.stringify(response.result)}`);
  }
  console.log(`${tx.TransactionType}: ${hash}`);
  await writeFile('transactions.jsonl', JSON.stringify({
    type: tx.TransactionType, account: tx.Account, hash,
    ledgerIndex: response.result.ledger_index,
  }) + '\n', { flag: 'a' });
  return response.result;
}

function isEntry(value: unknown, type: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null &&
    'LedgerEntryType' in value && value.LedgerEntryType === type;
}

async function readBalances(issuanceId: string, holder: string) {
  const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
  const ledgerHash = ledger.result.ledger_hash;
  const [holding, issuance] = await Promise.all([
    client.request({ command: 'ledger_entry', ledger_hash: ledgerHash,
      mptoken: { account: holder, mpt_issuance_id: issuanceId } }),
    client.request({ command: 'ledger_entry', ledger_hash: ledgerHash,
      mpt_issuance: issuanceId }),
  ]);
  const token: unknown = holding.result.node;
  const definition: unknown = issuance.result.node;
  if (!holding.result.validated || !issuance.result.validated ||
      !isEntry(token, 'MPToken') || !isEntry(definition, 'MPTokenIssuance')) {
    throw new Error('Expected validated MPT ledger entries');
  }
  if (typeof definition.Flags !== 'number' || typeof token.Flags !== 'number' ||
      typeof token.MPTAmount !== 'string' || typeof definition.OutstandingAmount !== 'string' ||
      definition.Issuer !== issuerAddress ||
      !(definition.Flags & 4) || // lsfMPTRequireAuth
      !(token.Flags & 2)) { // lsfMPTAuthorized
    throw new Error('Issuer or allow-list authorization verification failed');
  }
  const result = { issuanceId, holder, holderBalance: token.MPTAmount,
    outstandingAmount: definition.OutstandingAmount };
  console.log(`Validated ledger: ${ledgerHash}`);
  console.log(JSON.stringify(result, null, 2));
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function main() {
  await client.connect();
  try {
    if (process.argv.includes('--read')) {
      const result: unknown = JSON.parse(await readFile('result.json', 'utf8'));
      if (!result || typeof result !== 'object' || !('issuanceId' in result) ||
          !('holder' in result) || typeof result.issuanceId !== 'string' ||
          typeof result.holder !== 'string') throw new Error('Invalid result.json');
      await readBalances(result.issuanceId, result.holder);
      return;
    }
    const seed = process.env.ISSUER_SEED;
    if (!seed) throw new Error('Set ISSUER_SEED to your testnet issuer seed');
    const issuer = Wallet.fromSeed(seed);
    if (issuer.classicAddress !== issuerAddress) throw new Error('Unexpected issuer address');
    const holder = Wallet.generate();
    // Exclusive creation prevents accidentally running the issuance workflow twice.
    await writeFile('holder-wallet.json', JSON.stringify({
      address: holder.classicAddress, seed: holder.seed,
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await submit({ TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress, Amount: xrpToDrops('10') }, issuer);
    const created = await submit({ TransactionType: 'MPTokenIssuanceCreate',
      Account: issuerAddress, AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
    }, issuer);
    const meta = created.meta;
    if (!meta || typeof meta === 'string' || !('mpt_issuance_id' in meta) ||
        typeof meta.mpt_issuance_id !== 'string') {
      throw new Error('Validated creation metadata has no MPT issuance ID');
    }
    const issuanceId = meta.mpt_issuance_id;
    await writeFile('issuance.json', JSON.stringify({ issuanceId, holder: holder.classicAddress }, null, 2) + '\n');
    await submit({ TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId }, holder);
    await submit({ TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
      MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
    await submit({ TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
    const result = await readBalances(issuanceId, holder.classicAddress);
    if (result.holderBalance !== '1000' || result.outstandingAmount !== '1000') {
      throw new Error('Unexpected balances after issuing 1,000 tokens');
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
