import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Wallet, encode, decode, validate } from 'xrpl';
import { authorize, createIssuance, tokenPayment } from './transactions.js';

test('MPT transactions survive validation, binary encoding, and signing', () => {
  const issuer = Wallet.generate();
  const holder = Wallet.generate();
  const id = '00000001' + 'AB'.repeat(20);
  const transactions = [
    createIssuance(issuer.classicAddress),
    authorize(holder.classicAddress, id),
    authorize(issuer.classicAddress, id, holder.classicAddress),
    tokenPayment(issuer.classicAddress, holder.classicAddress, id),
  ];
  for (const tx of transactions) {
    const prepared = { ...tx, Fee: '12', Sequence: 1, LastLedgerSequence: 100 };
    validate(prepared);
    const decoded = decode(encode(prepared));
    for (const [key, value] of Object.entries(prepared)) assert.deepEqual(decoded[key], value);
    const wallet = tx.Account === issuer.classicAddress ? issuer : holder;
    assert.match(wallet.sign(prepared).hash, /^[A-F0-9]{64}$/);
  }
  assert.equal(transactions[0]?.Flags, 4);
  assert(!('Holder' in transactions[1]!));
  assert.equal(transactions[2]?.Holder, holder.classicAddress);
  assert.deepEqual(transactions[3]?.Amount, { mpt_issuance_id: id, value: '1000' });
});
