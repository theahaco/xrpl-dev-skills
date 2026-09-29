import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { Client, Wallet, MPTokenIssuanceCreateFlags, xrpToDrops, type SubmittableTransaction } from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rPrQskvFacjRfzF9cXsHTfuPXSQVwx5U8';
const client = new Client(endpoint);

async function submit(label: string, tx: SubmittableTransaction, wallet: Wallet) {
  const response = await client.submitAndWait(tx, { wallet, autofill: true });
  const { meta, hash, validated, ledger_index } = response.result;
  if (!validated || !meta || typeof meta === 'string' || meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`${label} failed: ${JSON.stringify(response.result)}`);
  }
  await appendFile('transactions.jsonl', JSON.stringify({ label, hash, ledger_index, meta }) + '\n');
  console.log(`${label}: ${hash} (validated)`);
  return meta;
}

async function readBalances(issuanceId: string, holder: string) {
  // Pin both reads to the same validated ledger.
  const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
  const ledger_hash = ledger.result.ledger_hash;
  const [holding, issuance] = await Promise.all([
    client.request({ command: 'ledger_entry', ledger_hash, mptoken: { account: holder, mpt_issuance_id: issuanceId } }),
    client.request({ command: 'ledger_entry', ledger_hash, mpt_issuance: issuanceId }),
  ]);
  // xrpl's LedgerEntry union omits MPToken; narrow the actual response at runtime.
  const token: unknown = holding.result.node;
  const mint = issuance.result.node;
  if (!token || typeof token !== 'object' || !('LedgerEntryType' in token) || token.LedgerEntryType !== 'MPToken' ||
      !('MPTAmount' in token) || typeof token.MPTAmount !== 'string' ||
      !('Flags' in token) || typeof token.Flags !== 'number' || mint.LedgerEntryType !== 'MPTokenIssuance') {
    throw new Error('Unexpected ledger entry types');
  }
  if (mint.Issuer !== issuerAddress || (mint.Flags & 4) === 0 || (token.Flags & 2) === 0) {
    throw new Error('Issuer or allow-list authorization verification failed');
  }
  const result = { issuanceId, holder, holderBalance: token.MPTAmount, outstandingAmount: mint.OutstandingAmount };
  await writeFile('ledger-evidence.json', JSON.stringify({ ledger_hash, holding: holding.result, issuance: issuance.result }, null, 2) + '\n');
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (result.holderBalance !== '1000' || result.outstandingAmount !== '1000') {
    throw new Error('Expected holder balance and outstanding amount to both be 1000');
  }
}

async function main() {
  if (process.argv.includes('--read')) {
    const saved: unknown = JSON.parse(await readFile('result.json', 'utf8'));
    if (!saved || typeof saved !== 'object' || !('issuanceId' in saved) || typeof saved.issuanceId !== 'string' || !('holder' in saved) || typeof saved.holder !== 'string') {
      throw new Error('Invalid result.json');
    }
    await client.connect();
    await readBalances(saved.issuanceId, saved.holder);
    return;
  }
  const seed = process.env.ISSUER_SEED;
  if (!seed) throw new Error('Set ISSUER_SEED to your testnet issuer seed');
  const issuer = Wallet.fromSeed(seed);
  if (issuer.classicAddress !== issuerAddress) throw new Error('Seed does not match the expected issuer');
  // Prevent accidental duplicate issuance. Preserve partial-run evidence on error.
  await writeFile('.run-started', new Date().toISOString(), { flag: 'wx' });
  const holder = Wallet.generate();
  await writeFile('.holder.json', JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await client.connect();
  await submit('Fund holder with 10 test XRP', {
    TransactionType: 'Payment', Account: issuerAddress, Destination: holder.classicAddress, Amount: xrpToDrops('10'),
  }, issuer);
  const meta = await submit('Create allow-listed MPT', {
    TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress, AssetScale: 0,
    Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth | MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
  }, issuer);
  if (!('mpt_issuance_id' in meta) || typeof meta.mpt_issuance_id !== 'string') {
    throw new Error('Validated creation metadata did not contain mpt_issuance_id; see transactions.jsonl');
  }
  const issuanceId = meta.mpt_issuance_id;
  await writeFile('issuance.json', JSON.stringify({ issuanceId, holder: holder.classicAddress }, null, 2) + '\n');
  await submit('Holder opts in', {
    TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: issuanceId,
  }, holder);
  await submit('Issuer approves holder', {
    TransactionType: 'MPTokenAuthorize', Account: issuerAddress, MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress,
  }, issuer);
  await submit('Issue 1000 tokens to holder', {
    TransactionType: 'Payment', Account: issuerAddress, Destination: holder.classicAddress,
    Amount: { mpt_issuance_id: issuanceId, value: '1000' },
  }, issuer);
  await readBalances(issuanceId, holder.classicAddress);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (client.isConnected()) await client.disconnect();
});
