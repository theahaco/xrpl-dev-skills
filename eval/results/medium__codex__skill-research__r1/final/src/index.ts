import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  Client, Wallet, MPTokenIssuanceCreateFlags, xrpToDrops,
  type SubmittableTransaction,
} from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rMCnv6DVfXrFfZsqPq9kqVAeGkVLAdn8wz';
const client = new Client(endpoint, { maxFeeXRP: '0.01' });
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

async function submit(label: string, transaction: SubmittableTransaction, wallet: Wallet) {
  const prepared = await client.autofill(transaction);
  assert(prepared.LastLedgerSequence, 'Transaction must expire');
  const signed = wallet.sign(prepared);
  // Save the hash before submission so an interrupted run can be investigated.
  await writeFile(`.local/${label}-pending.json`, json({ hash: signed.hash, prepared }));
  const response = await client.submitAndWait(signed.tx_blob);
  await writeFile(`receipts/${label}.json`, json(response));
  const { meta, validated } = response.result;
  assert.equal(validated, true, `${label}: transaction is not validated`);
  assert(meta && typeof meta !== 'string', `${label}: missing metadata`);
  assert.equal(meta.TransactionResult, 'tesSUCCESS', `${label}: transaction failed`);
  console.log(`${label}: ${signed.hash} (validated)`);
  return response.result;
}

async function readBalances(issuanceId: string, holder: string) {
  // Both balances come from the same validated ledger snapshot.
  const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
  const ledgerHash = ledger.result.ledger_hash;
  const [holding, issuance] = await Promise.all([
    client.request({ command: 'ledger_entry', ledger_hash: ledgerHash,
      mptoken: { mpt_issuance_id: issuanceId, account: holder } }),
    client.request({ command: 'ledger_entry', ledger_hash: ledgerHash,
      mpt_issuance: issuanceId }),
  ]);
  assert.equal(holding.result.validated, true);
  assert.equal(issuance.result.validated, true);
  // xrpl 5.3.0 omits MPToken from the LedgerEntry union; validate its wire fields.
  const token: unknown = holding.result.node;
  const issue = issuance.result.node;
  assert(token && typeof token === 'object' && 'LedgerEntryType' in token &&
    token.LedgerEntryType === 'MPToken' && 'MPTokenIssuanceID' in token &&
    'Flags' in token && typeof token.Flags === 'number' &&
    'MPTAmount' in token && typeof token.MPTAmount === 'string');
  assert(issue.LedgerEntryType === 'MPTokenIssuance');
  assert.equal(issue.Issuer, issuerAddress);
  assert.equal(token.MPTokenIssuanceID, issuanceId);
  assert.equal(issue.Flags & 4, 4, 'Issuer approval must be required');
  assert.equal(token.Flags & 2, 2, 'Holder must be issuer-authorized');
  assert.equal(issue.AssetScale ?? 0, 0);
  assert.equal(token.MPTAmount, '1000');
  assert.equal(issue.OutstandingAmount, '1000');
  await writeFile('ledger-evidence.json', json({ ledgerHash, holding, issuance }));
  const result = { issuanceId, holder, holderBalance: token.MPTAmount,
    outstandingAmount: issue.OutstandingAmount };
  await writeFile('result.json', json(result));
  console.log(json(result));
}

async function main() {
  await client.connect();
  try {
    const server = await client.request({ command: 'server_info' });
    assert.equal(server.result.info.network_id, 1, 'Expected XRPL testnet');
    if (process.argv.includes('--verify')) {
      const result: unknown = JSON.parse(await readFile('result.json', 'utf8'));
      assert(result && typeof result === 'object' && 'issuanceId' in result && 'holder' in result);
      assert(typeof result.issuanceId === 'string' && typeof result.holder === 'string');
      await readBalances(result.issuanceId, result.holder);
      return;
    }
    assert(!existsSync('.local/holder.json'),
      'A run already started. Use npm run verify after completion; inspect receipts before retrying.');
    assert(!existsSync('result.json'), 'Result already exists; use npm run verify.');
    const seed = process.env.ISSUER_SEED;
    assert(seed, 'Set ISSUER_SEED to your testnet issuer seed');
    const issuer = Wallet.fromSeed(seed);
    assert.equal(issuer.classicAddress, issuerAddress, 'Seed does not match issuer');
    const features = await client.request({ command: 'feature' });
    assert(Object.values(features.result.features).some(
      (feature) => feature.name === 'MPTokensV1' && feature.enabled), 'MPTokensV1 is disabled');
    await mkdir('research', { recursive: true });
    await writeFile('research/run-features.json', json(features));
    const reserves = server.result.info.validated_ledger;
    assert(reserves);
    console.log(`Reserves: ${reserves.reserve_base_xrp} XRP base + ${reserves.reserve_inc_xrp} XRP/object`);
    assert(5 > reserves.reserve_base_xrp + reserves.reserve_inc_xrp + 0.01,
      'Holder funding is insufficient for current reserves');
    const account = await client.request({ command: 'account_info', account: issuerAddress,
      ledger_index: 'validated' });
    const required = 5 + reserves.reserve_base_xrp +
      (account.result.account_data.OwnerCount + 1) * reserves.reserve_inc_xrp + 0.1;
    assert(BigInt(account.result.account_data.Balance) > BigInt(xrpToDrops(required)),
      'Issuer needs more XRP for funding, reserves, and fees');
    await mkdir('.local', { recursive: true, mode: 0o700 });
    await mkdir('receipts', { recursive: true });
    const holder = Wallet.generate();
    await writeFile('.local/holder.json', json({ address: holder.classicAddress, seed: holder.seed }),
      { mode: 0o600, flag: 'wx' });
    await submit('01-fund-holder', { TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress, Amount: xrpToDrops('5') }, issuer);
    const created = await submit('02-create-issuance', {
      TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress, AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    }, issuer);
    const meta = created.meta;
    assert(meta && typeof meta !== 'string' && 'mpt_issuance_id' in meta);
    const issuanceId = meta.mpt_issuance_id;
    assert(typeof issuanceId === 'string' && /^[A-F0-9]{48}$/i.test(issuanceId));
    await writeFile('.local/issuance.json', json({ issuanceId, holder: holder.classicAddress }));
    await submit('03-holder-opt-in', { TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress, MPTokenIssuanceID: issuanceId }, holder);
    await submit('04-issuer-approval', { TransactionType: 'MPTokenAuthorize',
      Account: issuerAddress, MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
    await submit('05-send-mpt', { TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress, Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
    await readBalances(issuanceId, holder.classicAddress);
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unexpected failure');
  process.exitCode = 1;
});
