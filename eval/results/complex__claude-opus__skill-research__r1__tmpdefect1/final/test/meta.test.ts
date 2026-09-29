import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TransactionMetadata } from 'xrpl';

import { mptBalanceChange } from '../src/meta.js';

const ID = '00000001F9FC7BE4B01D9CDAD2B6C0FCE8C09D4E1A2A6EA1';
const HOLDER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

function meta(nodes: unknown[]): TransactionMetadata {
  return { AffectedNodes: nodes, TransactionIndex: 0, TransactionResult: 'tesSUCCESS' } as TransactionMetadata;
}

describe('mptBalanceChange', () => {
  it('computes a partial clawback', () => {
    const m = meta([
      {
        ModifiedNode: {
          LedgerEntryType: 'MPToken',
          FinalFields: { Account: HOLDER, MPTokenIssuanceID: ID, MPTAmount: '700', Flags: 2 },
          PreviousFields: { MPTAmount: '1000' },
        },
      },
    ]);
    assert.equal(mptBalanceChange(m, ID, HOLDER), -300n);
  });

  it('treats an omitted final MPTAmount as zero (full clawback)', () => {
    const m = meta([
      {
        ModifiedNode: {
          LedgerEntryType: 'MPToken',
          FinalFields: { Account: HOLDER, MPTokenIssuanceID: ID, Flags: 0 },
          PreviousFields: { MPTAmount: '100' },
        },
      },
    ]);
    assert.equal(mptBalanceChange(m, ID, HOLDER), -100n);
  });

  it('ignores other holders, other issuances and unchanged balances', () => {
    const m = meta([
      { ModifiedNode: { LedgerEntryType: 'MPToken', FinalFields: { Account: 'rOther', MPTokenIssuanceID: ID, MPTAmount: '1' }, PreviousFields: { MPTAmount: '5' } } },
      { ModifiedNode: { LedgerEntryType: 'MPToken', FinalFields: { Account: HOLDER, MPTokenIssuanceID: 'FF', MPTAmount: '1' }, PreviousFields: { MPTAmount: '5' } } },
      { ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', FinalFields: { OutstandingAmount: '1' }, PreviousFields: { OutstandingAmount: '5' } } },
    ]);
    assert.equal(mptBalanceChange(m, ID, HOLDER), 0n);

    const flagsOnly = meta([
      { ModifiedNode: { LedgerEntryType: 'MPToken', FinalFields: { Account: HOLDER, MPTokenIssuanceID: ID, MPTAmount: '9', Flags: 3 }, PreviousFields: { Flags: 2 } } },
    ]);
    assert.equal(mptBalanceChange(flagsOnly, ID, HOLDER), 0n);
  });
});
