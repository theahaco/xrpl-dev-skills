import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, Wallet, validate } from 'xrpl';
import { createIssuance, tokenPayment } from './transactions.js';
test('issuance requires authorization; exact integer MPT payment survives serialization', () => {
    const issuer = Wallet.generate().classicAddress;
    const holder = Wallet.generate().classicAddress;
    const issuance = createIssuance(issuer);
    assert.equal(issuance.Flags, 4);
    assert.equal(issuance.AssetScale, 0);
    const payment = tokenPayment(issuer, holder, '00000001' + 'AB'.repeat(20));
    for (const tx of [issuance, payment]) {
        validate(tx);
        const decoded = decode(encode(tx));
        assert.equal(decoded.TransactionType, tx.TransactionType);
        if (tx.TransactionType === 'Payment') {
            assert.deepEqual(decoded.Amount, tx.Amount);
            assert.equal(decoded.Flags, undefined, 'No partial-payment flag');
        }
    }
});
