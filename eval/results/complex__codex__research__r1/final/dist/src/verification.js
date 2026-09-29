import assert from 'node:assert/strict';
import { Client } from 'xrpl';
import { AUTHORIZED, CAPABILITIES, LOCKED, readHolding, readIssuance, requireRedemptionGuard } from './issuer.js';
export const ISSUER_ADDRESS = 'rG7kN3XvQ2T3UvSzT55VKLXQjFrGw1LP3f';
export const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233';
/** Pin every read to one validated ledger, so the supply and holder checks are consistent. */
export async function verifyFinal(client, result) {
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    assert.equal(ledger.result.validated, true);
    const index = ledger.result.ledger_index;
    const issuerAccount = await requireRedemptionGuard(client, ISSUER_ADDRESS, index);
    const [issuance, A, B, C] = await Promise.all([
        readIssuance(client, result.issuanceId, index),
        readHolding(client, result.issuanceId, result.holders.A, index),
        readHolding(client, result.issuanceId, result.holders.B, index),
        readHolding(client, result.issuanceId, result.holders.C, index),
    ]);
    assert.equal(issuance.Issuer, ISSUER_ADDRESS);
    assert.equal(issuance.Flags, CAPABILITIES);
    assert.equal(issuance.OutstandingAmount, '1200');
    assert.equal(A?.MPTAmount, '500');
    assert.equal(A.Flags, AUTHORIZED);
    assert.equal(B?.MPTAmount, '700');
    assert.equal(B.Flags, AUTHORIZED | LOCKED);
    assert.equal(C?.MPTAmount ?? '0', '0');
    assert.equal((C?.Flags ?? 0) & AUTHORIZED, 0);
    return { checkedAt: new Date().toISOString(), ledgerIndex: index, ledgerHash: ledger.result.ledger_hash,
        issuer: ISSUER_ADDRESS, issuerAccount, issuance, holders: { A, B, C },
        policy: 'Issuer DepositAuth blocks holder redemption. Issuer module blocks minting to locked holders or globally locked issuance. Unrestricted issuer signing can bypass application policy.' };
}
