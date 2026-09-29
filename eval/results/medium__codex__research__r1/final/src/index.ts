import { existsSync } from 'node:fs';
import { writeFile, appendFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  Client, Wallet, MPTokenIssuanceCreateFlags,
  xrpToDrops, type SubmittableTransaction,
} from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rpiVYqiq6JUj2MwMLtnut5qjX5FQ2Ck1gV';
const mptAmendment = '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38';
const client = new Client(endpoint);
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

async function submit<T extends SubmittableTransaction>(transaction: T, wallet: Wallet) {
  const prepared = await client.autofill(transaction);
  const signed = wallet.sign(prepared);
  // Save the hash before submitting so an interrupted run can be investigated.
  await appendFile('transactions.jsonl', JSON.stringify({
    phase: 'prepared', type: transaction.TransactionType, hash: signed.hash,
    lastLedgerSequence: prepared.LastLedgerSequence,
  }) + '\n');
  const response = await client.submitAndWait(signed.tx_blob);
  const { meta } = response.result;
  assert(response.result.validated, 'Transaction must be validated');
  assert(meta && typeof meta !== 'string', 'Expected decoded metadata');
  await appendFile('transactions.jsonl', JSON.stringify({
    phase: 'validated', type: transaction.TransactionType, hash: signed.hash,
    ledgerIndex: response.result.ledger_index, result: meta.TransactionResult,
  }) + '\n');
  assert.equal(meta.TransactionResult, 'tesSUCCESS');
  console.log(`${transaction.TransactionType}: ${signed.hash}`);
  return response.result;
}

async function readBalances(issuanceId: string, holder: string) {
  const ledgerIndex = await client.getLedgerIndex();
  const issuanceResponse = await client.request({
    command: 'ledger_entry', mpt_issuance: issuanceId, ledger_index: ledgerIndex,
  });
  const holderResponse = await client.request({
    command: 'ledger_entry', mptoken: { account: holder, mpt_issuance_id: issuanceId },
    ledger_index: ledgerIndex,
  });
  assert(issuanceResponse.result.validated && holderResponse.result.validated);
  const issuance = issuanceResponse.result.node;
  // xrpl 5.3.0 omits MPToken from its LedgerEntry union. Validate these fields.
  const token = holderResponse.result.node as unknown as Record<string, unknown>;
  assert(issuance.LedgerEntryType === 'MPTokenIssuance');
  assert(token.LedgerEntryType === 'MPToken');
  assert.equal(issuance.Issuer, issuerAddress);
  assert(issuance.Flags & 0x00000004, 'Issuance must require authorization');
  assert(typeof token.Flags === 'number' && typeof token.MPTAmount === 'string');
  assert(token.Flags & 0x00000002, 'Holder must have lsfMPTAuthorized');
  assert.equal(token.MPTAmount, '1000');
  assert.equal(issuance.OutstandingAmount, '1000');
  await writeFile('verification.json', json({
    endpoint, issuance: issuanceResponse.result, holder: holderResponse.result,
  }));
  const result = { issuanceId, holder, holderBalance: token.MPTAmount,
    outstandingAmount: issuance.OutstandingAmount };
  await writeFile('result.json', json(result));
  console.log(json(result));
}

async function main() {
  await client.connect();
  try {
    if (process.argv.includes('--verify')) {
      const saved = JSON.parse(await readFile('result.json', 'utf8')) as {
        issuanceId: string; holder: string;
      };
      await readBalances(saved.issuanceId, saved.holder);
      return;
    }
    assert(!existsSync('transactions.jsonl') && !existsSync('holder-wallet.json'),
      'A run already exists. Use npm run verify; inspect the journal before starting another issuance.');
    const seed = process.env.ISSUER_SEED;
    assert(seed, 'Set ISSUER_SEED in .env or the environment');
    const issuer = Wallet.fromSeed(seed);
    assert.equal(issuer.classicAddress, issuerAddress, 'Incorrect issuer seed');
    const amendments = await client.request({
      command: 'ledger_entry', amendments: true, ledger_index: 'validated',
    });
    assert(amendments.result.validated);
    assert(amendments.result.node.LedgerEntryType === 'Amendments');
    assert(amendments.result.node.Amendments?.includes(mptAmendment),
      'MPTokensV1 is not enabled');
    await writeFile('research/run-amendments.json', json(amendments.result));

    const holder = Wallet.generate();
    await writeFile('holder-wallet.json', json({ address: holder.classicAddress,
      seed: holder.seed }), { mode: 0o600, flag: 'wx' });
    await submit({ TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress, Amount: xrpToDrops('10') }, issuer);
    const creation = await submit({ TransactionType: 'MPTokenIssuanceCreate',
      Account: issuerAddress, AssetScale: 0, MaximumAmount: '1000',
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth }, issuer);
    const meta = creation.meta;
    assert(meta && typeof meta !== 'string');
    assert('mpt_issuance_id' in meta);
    const issuanceId = meta.mpt_issuance_id;
    assert(typeof issuanceId === 'string' && /^[A-F0-9]{48}$/i.test(issuanceId));
    await writeFile('issuance.json', json({ issuanceId, holder: holder.classicAddress }));
    await submit({ TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId }, holder);
    await submit({ TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
      MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
    await submit({ TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
    await readBalances(issuanceId, holder.classicAddress);
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
