import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TransactionMetadata } from 'xrpl'

import { mptBalanceDecrease } from '../src/ledger.js'

const ID = '0000000000000000000000000000000000000000000000AA'

function meta(previous: Record<string, unknown> | undefined, final: Record<string, unknown>): TransactionMetadata {
  return {
    TransactionIndex: 0,
    TransactionResult: 'tesSUCCESS',
    AffectedNodes: [
      {
        ModifiedNode: {
          LedgerEntryType: 'MPToken',
          LedgerIndex: 'X',
          FinalFields: { Account: 'rHolder', MPTokenIssuanceID: ID, Flags: 0, ...final },
          ...(previous && { PreviousFields: previous }),
        },
      },
    ],
  } as TransactionMetadata
}

describe('mptBalanceDecrease', () => {
  it('reads a partial clawback', () => {
    assert.equal(mptBalanceDecrease(meta({ MPTAmount: '1000' }, { MPTAmount: '700' }), ID, 'rHolder'), 300n)
  })

  it('reads a full clawback, where the ledger drops MPTAmount', () => {
    assert.equal(mptBalanceDecrease(meta({ MPTAmount: '250' }, {}), ID, 'rHolder'), 250n)
  })

  it('ignores other holders, other issuances and unchanged balances', () => {
    assert.equal(mptBalanceDecrease(meta({ MPTAmount: '10' }, { MPTAmount: '5' }), ID, 'rOther'), 0n)
    assert.equal(mptBalanceDecrease(meta({ MPTAmount: '10' }, { MPTAmount: '5' }), ID.replace('AA', 'BB'), 'rHolder'), 0n)
    assert.equal(mptBalanceDecrease(meta({ Flags: 1 }, { MPTAmount: '5' }), ID, 'rHolder'), 0n)
    assert.equal(mptBalanceDecrease(meta(undefined, { MPTAmount: '5' }), ID, 'rHolder'), 0n)
  })
})
