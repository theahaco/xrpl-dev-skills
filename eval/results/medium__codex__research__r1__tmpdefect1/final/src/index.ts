import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  Client, MPTokenIssuanceCreateFlags,
  Wallet, xrpToDrops, type SubmittableTransaction,
} from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rEyNWbgPq7jnWYa7dnWPVtsHZxroy3XGVd';
const amendmentsIndex = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
const requiredAmendments = {
  MPTokensV1: '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38',
  fixMPTDeliveredAmount: 'AB8D932A5F338903FE5BCBD80B611FFED70839ABA3170E9CE01D947C0EDEDCF2',
};
const client = new Client(endpoint);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface Result {
  issuanceId: string;
  holder: string;
  holderBalance: string;
  outstandingAmount: string;
}

async function checkNetwork(): Promise<void> {
  const info = await client.request({ command: 'server_info' });
  assert.equal(info.result.info.network_id, 1, 'Expected XRPL Testnet network ID 1');
  const amendments = await client.request({
    command: 'ledger_entry', index: amendmentsIndex, ledger_index: 'validated',
  });
  const node = amendments.result.node;
  assert.equal(amendments.result.validated, true);
  assert(node?.LedgerEntryType === 'Amendments');
  for (const [name, id] of Object.entries(requiredAmendments)) {
    assert(node.Amendments?.includes(id), `${name} is not enabled`);
  }
  await writeFile('research/runtime-amendments.json', json(amendments));
}

async function readBalances(issuanceId: string, holder: string): Promise<Result> {
  // Pin both reads to the same validated ledger version.
  const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
  assert.equal(ledger.result.validated, true);
  const ledger_hash = ledger.result.ledger_hash;
  const [issuanceResponse, holderResponse] = await Promise.all([
    client.request({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_hash }),
    client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder }, ledger_hash,
    }),
  ]);
  assert.equal(issuanceResponse.result.validated, true);
  assert.equal(holderResponse.result.validated, true);
  const issuance = issuanceResponse.result.node;
  // xrpl 5.3.0 omits MPToken from its LedgerEntry union; validate the wire data.
  const holding: unknown = holderResponse.result.node;
  assert(issuance?.LedgerEntryType === 'MPTokenIssuance');
  assert(holding && typeof holding === 'object' &&
    'LedgerEntryType' in holding && holding.LedgerEntryType === 'MPToken' &&
    'MPTokenIssuanceID' in holding && typeof holding.MPTokenIssuanceID === 'string' &&
    'Account' in holding && holding.Account === holder &&
    'Flags' in holding && typeof holding.Flags === 'number' &&
    'MPTAmount' in holding && typeof holding.MPTAmount === 'string');
  assert.equal(issuance.Issuer, issuerAddress);
  assert.equal(holding.MPTokenIssuanceID, issuanceId);
  assert(issuance.Flags & 0x00000004, 'Issuance must have lsfMPTRequireAuth');
  assert(holding.Flags & 0x00000002, 'Holder must have lsfMPTAuthorized');
  assert.equal(issuance.AssetScale ?? 0, 0);
  assert.equal(holding.MPTAmount, '1000');
  assert.equal(issuance.OutstandingAmount, '1000');
  await writeFile('ledger-evidence.json', json({
    endpoint, ledgerHash: ledger_hash, ledgerIndex: ledger.result.ledger_index,
    issuance: issuanceResponse.result, holder: holderResponse.result,
  }));
  const result = {
    issuanceId, holder, holderBalance: holding.MPTAmount,
    outstandingAmount: issuance.OutstandingAmount,
  };
  await writeFile('result.json', json(result));
  console.log(json(result));
  return result;
}

async function issue(): Promise<void> {
  const seed = process.env.ISSUER_SEED;
  assert(seed, 'Set ISSUER_SEED to the supplied testnet seed');
  const issuer = Wallet.fromSeed(seed);
  assert.equal(issuer.classicAddress, issuerAddress, 'Seed does not match issuer');
  // Exclusive creation prevents an accidental rerun from issuing another token.
  await writeFile('transactions.json', '[]\n', { flag: 'wx' });
  const holder = Wallet.generate();
  assert(holder.seed);
  await mkdir('.secrets', { recursive: true, mode: 0o700 });
  await writeFile('.secrets/holder.json', json({
    address: holder.classicAddress, seed: holder.seed,
  }), { mode: 0o600, flag: 'wx' });

  const transactions: Array<Record<string, unknown>> = [];
  async function submit(label: string, transaction: SubmittableTransaction, wallet: Wallet) {
    const prepared = await client.autofill(transaction);
    const signed = wallet.sign(prepared);
    const entry: Record<string, unknown> = {
      label, hash: signed.hash, transaction: prepared, status: 'pending',
    };
    transactions.push(entry);
    // Journal the hash before submission so an interrupted run can be investigated.
    await writeFile('transactions.json', json(transactions));
    const response = await client.submitAndWait(signed.tx_blob);
    const meta = response.result.meta;
    assert.equal(response.result.validated, true, `${label} is not validated`);
    assert(meta && typeof meta !== 'string', `${label} has no parsed metadata`);
    entry.status = meta.TransactionResult;
    entry.ledgerIndex = response.result.ledger_index;
    entry.metadata = meta;
    await writeFile('transactions.json', json(transactions));
    assert.equal(meta.TransactionResult, 'tesSUCCESS', `${label} failed`);
    console.log(`${label}: ${signed.hash} (validated tesSUCCESS)`);
    return meta;
  }

  await submit('Fund holder with 10 test XRP', {
    TransactionType: 'Payment', Account: issuerAddress,
    Destination: holder.classicAddress, Amount: xrpToDrops(10),
  }, issuer);
  const metadata = await submit('Create approval-required MPT issuance', {
    TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress,
    AssetScale: 0,
    Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
  }, issuer);
  assert('mpt_issuance_id' in metadata && typeof metadata.mpt_issuance_id === 'string',
    'Creation metadata is missing mpt_issuance_id');
  const issuanceId = metadata.mpt_issuance_id;
  await writeFile('issuance.json', json({ issuanceId, holder: holder.classicAddress }));
  await submit('Holder opts in', {
    TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  }, holder);
  await submit('Issuer approves holder', {
    TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
    MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress,
  }, issuer);
  await submit('Issue 1000 MPT to holder', {
    TransactionType: 'Payment', Account: issuerAddress,
    Destination: holder.classicAddress,
    Amount: { mpt_issuance_id: issuanceId, value: '1000' },
  }, issuer);
  await readBalances(issuanceId, holder.classicAddress);
}

try {
  await client.connect();
  await checkNetwork();
  if (process.argv.includes('--verify')) {
    const saved: unknown = JSON.parse(await readFile('issuance.json', 'utf8'));
    assert(saved && typeof saved === 'object' &&
      'issuanceId' in saved && typeof saved.issuanceId === 'string' &&
      'holder' in saved && typeof saved.holder === 'string');
    await readBalances(saved.issuanceId, saved.holder);
  } else {
    await issue();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MPT demo failed');
  process.exitCode = 1;
} finally {
  await client.disconnect();
}
