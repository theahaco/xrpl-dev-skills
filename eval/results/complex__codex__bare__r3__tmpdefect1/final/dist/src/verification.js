import assert from 'node:assert/strict';
import { ISSUANCE_FLAGS } from './issuer.js';
export async function verifyFinal(client, issuer, result) {
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    assert.equal(ledger.result.validated, true);
    const hash = ledger.result.ledger_hash;
    // Every object is read from exactly the same validated ledger snapshot.
    const [issuance, A, B, C] = await Promise.all([
        issuer.issuance(hash), issuer.state(result.holders.A, hash),
        issuer.state(result.holders.B, hash), issuer.state(result.holders.C, hash),
    ]);
    assert.equal(issuance.Issuer, issuer.signer.address);
    assert.equal(issuance.Flags, ISSUANCE_FLAGS);
    assert.equal(issuance.OutstandingAmount, '1200');
    assert.equal(issuance.AssetScale ?? 0, 0);
    assert.equal(issuance.TransferFee ?? 0, 0);
    assert.equal(issuance.DomainID, undefined);
    assert.deepEqual(A, { exists: true, balance: '500', authorized: true, frozen: false });
    assert.deepEqual(B, { exists: true, balance: '700', authorized: true, frozen: true });
    assert.equal(C.balance, '0');
    assert.equal(C.authorized, false);
    return { ledgerHash: hash, ledgerIndex: ledger.result.ledger_index, issuer: issuance.Issuer,
        issuanceId: issuer.issuanceId, issuanceFlags: issuance.Flags, globallyFrozen: false,
        outstandingAmount: issuance.OutstandingAmount, holders: { A, B, C } };
}
//# sourceMappingURL=verification.js.map