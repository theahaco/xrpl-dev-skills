import assert from 'node:assert/strict';
import { AUTHORIZED, LOCKED, CAPABILITIES } from './issuer.js';
export async function verify(issuer, result) {
    await issuer.assertConfiguration();
    const ledger = await issuer.runtime.client.request({ command: 'ledger', ledger_index: 'validated' });
    const hash = ledger.result.ledger_hash;
    const [issuance, A, B, C] = await Promise.all([
        issuer.issuance(hash), issuer.holder(result.holders.A, hash),
        issuer.holder(result.holders.B, hash), issuer.holder(result.holders.C, hash),
    ]);
    assert.equal(issuance.Flags, CAPABILITIES);
    assert.equal(issuance.OutstandingAmount, '1200');
    assert.equal(A?.MPTAmount, '500');
    assert.equal(A.Flags, AUTHORIZED);
    assert.equal(B?.MPTAmount, '700');
    assert.equal(B.Flags, AUTHORIZED | LOCKED);
    assert.equal(C?.MPTAmount ?? '0', '0');
    assert.equal((C?.Flags ?? 0) & AUTHORIZED, 0);
    assert.equal(await issuer.isBanned(result.holders.C), true);
    return { checkedAt: new Date().toISOString(), ledgerHash: hash, ledgerIndex: ledger.result.ledger_index, issuance, holders: { A, B, C } };
}
