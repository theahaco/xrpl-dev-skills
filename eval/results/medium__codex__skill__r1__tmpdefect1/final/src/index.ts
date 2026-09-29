import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  Client, Wallet, MPTokenIssuanceCreateFlags,
  xrpToDrops, type SubmittableTransaction,
} from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rnW24ustzaxhYDKYj36XWZ79MGpFRgR3SP';
const client = new Client(endpoint);
const receipts: Array<{ step: string; hash: string; ledgerIndex: number }> = [];

async function submit(step: string, tx: SubmittableTransaction, wallet: Wallet) {
  // Autofill sets the current Sequence, fee, and a bounded LastLedgerSequence.
  const prepared = await client.autofill(tx);
  assert(prepared.LastLedgerSequence);
  const signed = wallet.sign(prepared);
  // Persist the hash before submission so an interrupted run can be investigated.
  await writeFile('.local/pending.json', JSON.stringify({ step, hash: signed.hash, prepared }, null, 2));
  // submitAndWait tracks the same transaction through queuing until validation.
  // Never blindly resend a payment after a timeout or sequence error.
  const { result } = await client.submitAndWait(signed.tx_blob);
  assert.equal(result.validated, true, `${step}: transaction not validated`);
  const meta = result.meta;
  assert(meta && typeof meta !== 'string', `${step}: missing metadata`);
  assert.equal(meta.TransactionResult, 'tesSUCCESS', `${step}: ledger rejected transaction`);
  assert(typeof result.ledger_index === 'number');
  receipts.push({ step, hash: signed.hash, ledgerIndex: result.ledger_index });
  await writeFile('transactions.json', JSON.stringify(receipts, null, 2) + '\n');
  console.log(`${step}: ${signed.hash} (validated)`);
  return { meta, ledgerIndex: result.ledger_index };
}

async function readBalances(issuanceId: string, holder: string) {
  // Pin both queries to the same validated ledger snapshot.
  const snapshot = await client.request({ command: 'ledger', ledger_index: 'validated' });
  assert.equal(snapshot.result.validated, true);
  const ledgerHash = snapshot.result.ledger_hash;
  const [issuanceResponse, holderResponse] = await Promise.all([
    client.request({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_hash: ledgerHash }),
    client.request({ command: 'ledger_entry', mptoken: { account: holder, mpt_issuance_id: issuanceId }, ledger_hash: ledgerHash }),
  ]);
  assert.equal(issuanceResponse.result.validated, true);
  assert.equal(holderResponse.result.validated, true);
  const issuance = issuanceResponse.result.node;
  // xrpl 5.3 omits MPToken from its LedgerEntry union; validate the raw node.
  const holding: unknown = holderResponse.result.node;
  assert(issuance?.LedgerEntryType === 'MPTokenIssuance');
  assert(holding && typeof holding === 'object' && 'LedgerEntryType' in holding && holding.LedgerEntryType === 'MPToken');
  assert('Flags' in holding && typeof holding.Flags === 'number');
  assert('MPTAmount' in holding && typeof holding.MPTAmount === 'string');
  assert.equal(issuance.Issuer, issuerAddress);
  assert(issuance.Flags & 0x4, 'Issuance must have lsfMPTRequireAuth');
  assert(holding.Flags & 0x2, 'Holder must have lsfMPTAuthorized');
  const result = {
    issuanceId, holder,
    holderBalance: holding.MPTAmount,
    outstandingAmount: issuance.OutstandingAmount,
  };
  await writeFile('ledger-proof.json', JSON.stringify({ ledgerHash, issuance: issuanceResponse.result, holder: holderResponse.result }, null, 2) + '\n');
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  await client.connect();
  try {
    const server = await client.request({ command: 'server_info' });
    assert.equal(server.result.info.network_id, 1, 'Expected XRPL testnet');
    if (process.argv.includes('--read')) {
      const saved: unknown = JSON.parse(await readFile('result.json', 'utf8'));
      assert(saved && typeof saved === 'object' && 'issuanceId' in saved && 'holder' in saved);
      assert(typeof saved.issuanceId === 'string' && typeof saved.holder === 'string');
      await readBalances(saved.issuanceId, saved.holder);
      return;
    }
    const seed = process.env.ISSUER_SEED;
    assert(seed, 'Set ISSUER_SEED to the testnet issuer seed');
    const issuer = Wallet.fromSeed(seed);
    assert.equal(issuer.classicAddress, issuerAddress, 'Wrong issuer seed');
    const reserve = server.result.info.validated_ledger;
    assert(reserve);
    assert(reserve.reserve_base_xrp + reserve.reserve_inc_xrp + 0.1 < 5, 'Holder needs more funding with current reserves');
    const account = await client.request({ command: 'account_info', account: issuerAddress, ledger_index: 'validated' });
    const requiredXrp = 5.1 + reserve.reserve_base_xrp + (account.result.account_data.OwnerCount + 1) * reserve.reserve_inc_xrp;
    assert(BigInt(account.result.account_data.Balance) > BigInt(xrpToDrops(requiredXrp)), 'Insufficient spendable issuer XRP');
    await mkdir('.local', { recursive: true, mode: 0o700 });
    // Exclusive creation prevents accidental duplicate issuance on a second run.
    await writeFile('.local/run.lock', 'Started; use npm run read after success. Inspect transaction hashes before restarting.\n', { flag: 'wx', mode: 0o600 });
    const holder = Wallet.generate();
    await writeFile('.local/holder.json', JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + '\n', { mode: 0o600 });
    await submit('Fund holder with 5 test XRP', {
      TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress, Amount: xrpToDrops('5'),
    }, issuer);
    const created = await submit('Create approval-required MPT', {
      TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress,
      AssetScale: 0, MaximumAmount: '1000000',
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    }, issuer);
    assert('mpt_issuance_id' in created.meta && typeof created.meta.mpt_issuance_id === 'string', 'Missing issuance ID');
    const issuanceId = created.meta.mpt_issuance_id;
    await writeFile('.local/issuance.json', JSON.stringify({ issuanceId, holder: holder.classicAddress }, null, 2));
    await submit('Holder opts in', {
      TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    }, holder);
    await submit('Issuer approves holder', {
      TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
      MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress,
    }, issuer);
    await submit('Send 1000 MPT', {
      TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: '1000' },
    }, issuer);
    const result = await readBalances(issuanceId, holder.classicAddress);
    assert.equal(result.holderBalance, '1000');
    assert.equal(result.outstandingAmount, '1000');
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
