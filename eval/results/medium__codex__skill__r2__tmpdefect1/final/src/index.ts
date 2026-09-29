import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  Client, Wallet, MPTokenIssuanceCreateFlags, xrpToDrops,
  type SubmittableTransaction,
} from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rQrYRxcY7K6oVjdkjZL5XgRN9UKCY648av';
const client = new Client(endpoint);
const evidence: { label: string; hash: string; ledgerIndex: number }[] = [];

async function submit(label: string, tx: SubmittableTransaction, wallet: Wallet) {
  // autofill supplies the current sequence, fee and LastLedgerSequence.
  const prepared = await client.autofill(tx);
  assert(prepared.LastLedgerSequence !== undefined);
  const signed = wallet.sign(prepared);
  console.log(`${label}: ${signed.hash}`);
  // Persist the hash before submission so an interrupted run can be investigated.
  await writeFile('pending-transaction.json', JSON.stringify({ label, hash: signed.hash,
    lastLedgerSequence: prepared.LastLedgerSequence }, null, 2) + '\n');
  const { result } = await client.submitAndWait(signed.tx_blob);
  assert.equal(result.validated, true, `${label} was not validated`);
  const meta = result.meta;
  assert(meta && typeof meta === 'object', 'Missing transaction metadata');
  assert.equal(meta.TransactionResult, 'tesSUCCESS', `${label}: ${meta.TransactionResult}`);
  assert(typeof result.ledger_index === 'number');
  evidence.push({ label, hash: signed.hash, ledgerIndex: result.ledger_index });
  await writeFile('transactions.json', JSON.stringify(evidence, null, 2) + '\n');
  return meta;
}

async function readBalances(issuanceId: string, holder: string) {
  // Pin both reads to the same validated ledger snapshot.
  const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
  assert.equal(ledger.result.validated, true);
  const ledgerHash = ledger.result.ledger_hash;
  const [issuanceResponse, holderResponse] = await Promise.all([
    client.request({ command: 'ledger_entry', mpt_issuance: issuanceId,
      ledger_hash: ledgerHash }),
    client.request({ command: 'ledger_entry', mptoken: {
      mpt_issuance_id: issuanceId, account: holder }, ledger_hash: ledgerHash }),
  ]);
  assert.equal(issuanceResponse.result.validated, true);
  assert.equal(holderResponse.result.validated, true);
  const issuance = issuanceResponse.result.node;
  // xrpl 5.3's LedgerEntry union omits MPToken; validate the response at runtime.
  const holding: unknown = holderResponse.result.node;
  assert(issuance?.LedgerEntryType === 'MPTokenIssuance');
  assert(holding && typeof holding === 'object' && 'LedgerEntryType' in holding &&
    holding.LedgerEntryType === 'MPToken' && 'Flags' in holding &&
    typeof holding.Flags === 'number' && 'MPTAmount' in holding &&
    typeof holding.MPTAmount === 'string');
  assert.equal(issuance.Issuer, issuerAddress);
  assert(issuance.Flags & MPTokenIssuanceCreateFlags.tfMPTRequireAuth);
  assert(holding.Flags & 2, 'Holder must have lsfMPTAuthorized');
  const result = { issuanceId, holder, holderBalance: holding.MPTAmount,
    outstandingAmount: issuance.OutstandingAmount };
  await writeFile('ledger-evidence.json', JSON.stringify({ ledgerHash,
    ledgerIndex: ledger.result.ledger_index, issuance, holding }, null, 2) + '\n');
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  await client.connect();
  try {
    const info = (await client.request({ command: 'server_info' })).result.info;
    assert.equal(info.network_id, 1, 'Expected XRPL testnet');
    if (process.argv.includes('--read')) {
      const saved: unknown = JSON.parse(await readFile('issuance.json', 'utf8'));
      assert(saved && typeof saved === 'object' && 'issuanceId' in saved &&
        'holder' in saved && typeof saved.issuanceId === 'string' &&
        typeof saved.holder === 'string');
      await readBalances(saved.issuanceId, saved.holder);
      return;
    }
    assert(!existsSync('.holder.json'),
      'A run already exists. Use npm run read; inspect transaction hashes before restarting.');
    const seed = process.env.ISSUER_SEED;
    assert(seed, 'Set ISSUER_SEED to your testnet seed');
    const issuer = Wallet.fromSeed(seed);
    assert.equal(issuer.classicAddress, issuerAddress, 'Unexpected issuer');
    const reserves = info.validated_ledger;
    assert(reserves);
    console.log(`Reserves: ${reserves.reserve_base_xrp} XRP base, ` +
      `${reserves.reserve_inc_xrp} XRP per object. Each account will own one MPT object.`);
    assert(5 > reserves.reserve_base_xrp + reserves.reserve_inc_xrp + 0.01);
    const account = (await client.request({ command: 'account_info',
      account: issuerAddress, ledger_index: 'validated' })).result.account_data;
    const needed = 5.01 + reserves.reserve_base_xrp +
      (account.OwnerCount + 1) * reserves.reserve_inc_xrp;
    assert(BigInt(account.Balance) > BigInt(xrpToDrops(needed)), 'Insufficient issuer XRP');
    const holder = Wallet.generate();
    await writeFile('.holder.json', JSON.stringify({ address: holder.classicAddress,
      seed: holder.seed }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await submit('Fund holder with 5 test XRP', { TransactionType: 'Payment',
      Account: issuerAddress, Destination: holder.classicAddress, Amount: xrpToDrops(5) }, issuer);
    const meta = await submit('Create authorized MPT', {
      TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress,
      AssetScale: 0, MaximumAmount: '1000000',
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
    }, issuer);
    assert('mpt_issuance_id' in meta && typeof meta.mpt_issuance_id === 'string',
      'Issuance ID missing from validated creation metadata');
    const issuanceId = meta.mpt_issuance_id;
    await writeFile('issuance.json', JSON.stringify({ issuanceId,
      holder: holder.classicAddress }, null, 2) + '\n');
    await submit('Holder opts in', { TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress, MPTokenIssuanceID: issuanceId }, holder);
    await submit('Issuer approves holder', { TransactionType: 'MPTokenAuthorize',
      Account: issuerAddress, MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
    await submit('Send 1000 MPT', { TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress, Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
    const result = await readBalances(issuanceId, holder.classicAddress);
    assert.equal(result.holderBalance, '1000');
    assert.equal(result.outstandingAmount, '1000');
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
