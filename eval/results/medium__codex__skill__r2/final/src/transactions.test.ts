import assert from 'node:assert/strict';
import test from 'node:test';
import { decode, Wallet } from 'xrpl';
import { createIssuance, tokenPayment } from './transactions.js';

test('signed issuance preserves required authorization and whole-token scale', () => {
  const wallet = Wallet.generate();
  const signed = wallet.sign({ ...createIssuance(wallet.classicAddress),
    Sequence: 1, Fee: '10', LastLedgerSequence: 100 });
  const decoded = decode(signed.tx_blob);
  assert.equal(Number(decoded.Flags) & 4, 4);
  assert.equal(decoded.AssetScale, 0);
});

test('signed payment uses an MPT amount of exactly 1,000 without partial payment', () => {
  const wallet = Wallet.generate();
  const issuanceId = '00000001' + 'AB'.repeat(20);
  const signed = wallet.sign({
    ...tokenPayment(wallet.classicAddress, Wallet.generate().classicAddress, issuanceId),
    Sequence: 2, Fee: '10', LastLedgerSequence: 100,
  });
  const decoded = decode(signed.tx_blob);
  assert.deepEqual(decoded.Amount, { mpt_issuance_id: issuanceId, value: '1000' });
  assert.equal(Number(decoded.Flags ?? 0) & 0x00020000, 0);
});
