import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VerificationError } from '../errors.js';
import { clawedBackFromMeta } from '../issuer.js';
const ISSUANCE = '0000000147D4F33C69F0E9A7E6D0A4C5E0A9C9F4D1B2A3C4';
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
function meta(previous, final) {
    return {
        TransactionIndex: 0,
        TransactionResult: 'tesSUCCESS',
        AffectedNodes: [
            {
                ModifiedNode: {
                    LedgerEntryType: 'MPToken',
                    LedgerIndex: 'AB',
                    FinalFields: {
                        Account: HOLDER,
                        MPTokenIssuanceID: ISSUANCE,
                        Flags: 2,
                        ...(final === undefined ? {} : { MPTAmount: final }),
                    },
                    ...(previous === undefined ? {} : { PreviousFields: { MPTAmount: previous } }),
                },
            },
        ],
    };
}
describe('clawedBackFromMeta', () => {
    it('computes a partial clawback', () => {
        assert.equal(clawedBackFromMeta(meta('1000', '700'), ISSUANCE, HOLDER), 300n);
    });
    it('handles a clawback to zero, where rippled omits MPTAmount from FinalFields', () => {
        assert.equal(clawedBackFromMeta(meta('100', undefined), ISSUANCE, HOLDER), 100n);
    });
    it('throws when the holder MPToken was not modified', () => {
        assert.throws(() => clawedBackFromMeta(meta('1', '0'), ISSUANCE, 'rOther'), VerificationError);
    });
});
//# sourceMappingURL=meta.test.js.map