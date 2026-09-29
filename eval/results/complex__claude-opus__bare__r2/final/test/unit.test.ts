import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { TransactionMetadata } from 'xrpl'

import { MAX_MPT_AMOUNT, parseAmount } from '../src/amount.js'
import { FileBanRegistry } from '../src/ban-registry.js'
import { InvalidInputError } from '../src/errors.js'
import { holderDebit } from '../src/ledger.js'
import { creationFlags, IssuanceFlag, issuanceProblems } from '../src/policy.js'

const ISSUER = 'rwDBaVnRzpLKzSszn596BEQKnhmYp9SnkL'
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const ID = '0000000000000000000000000000000000000000000000AB'

describe('parseAmount', () => {
  it('accepts integer base units in every input form', () => {
    assert.equal(parseAmount(500), 500n)
    assert.equal(parseAmount('1000'), 1000n)
    assert.equal(parseAmount(MAX_MPT_AMOUNT), MAX_MPT_AMOUNT)
  })

  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '1.0', '1e3', ' 1', '', '-5', 0n, MAX_MPT_AMOUNT + 1n]) {
    it(`rejects ${String(bad)}`, () => {
      assert.throws(() => parseAmount(bad), InvalidInputError)
    })
  }
})

describe('issuanceProblems', () => {
  const compliant = { Issuer: ISSUER, Flags: creationFlags(true) }

  it('accepts the flags we create issuances with', () => {
    assert.deepEqual(issuanceProblems(compliant, ISSUER), [])
    assert.deepEqual(issuanceProblems({ Issuer: ISSUER, Flags: creationFlags(false) }, ISSUER), [])
  })

  it('accepts a globally frozen issuance', () => {
    assert.deepEqual(issuanceProblems({ ...compliant, Flags: compliant.Flags | IssuanceFlag.Locked }, ISSUER), [])
  })

  it('flags each missing control', () => {
    for (const bit of [IssuanceFlag.CanLock, IssuanceFlag.RequireAuth, IssuanceFlag.CanClawback]) {
      assert.equal(issuanceProblems({ ...compliant, Flags: compliant.Flags & ~bit }, ISSUER).length, 1)
    }
  })

  it('flags each escape hatch', () => {
    for (const bit of [IssuanceFlag.CanEscrow, IssuanceFlag.CanTrade, IssuanceFlag.CanHoldConfidentialBalance]) {
      assert.equal(issuanceProblems({ ...compliant, Flags: compliant.Flags | bit }, ISSUER).length, 1)
    }
  })

  it('flags a DomainID, a foreign issuer and escrowed amounts', () => {
    assert.equal(issuanceProblems({ ...compliant, DomainID: 'AB'.repeat(32) }, ISSUER).length, 1)
    assert.equal(issuanceProblems(compliant, HOLDER).length, 1)
    assert.equal(issuanceProblems({ ...compliant, LockedAmount: '5' }, ISSUER).length, 1)
  })
})

describe('holderDebit', () => {
  const meta = (previous: Record<string, unknown> | undefined, final: Record<string, unknown>): TransactionMetadata =>
    ({
      TransactionIndex: 0,
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [
        { ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', LedgerIndex: 'X', FinalFields: {}, PreviousFields: {} } },
        {
          ModifiedNode: {
            LedgerEntryType: 'MPToken',
            LedgerIndex: 'Y',
            FinalFields: { Account: HOLDER, MPTokenIssuanceID: ID, Flags: 0, ...final },
            ...(previous !== undefined ? { PreviousFields: previous } : {}),
          },
        },
      ],
    }) as unknown as TransactionMetadata

  it('reads a partial debit', () => {
    assert.equal(holderDebit(meta({ MPTAmount: '1000' }, { MPTAmount: '700' }), ID, HOLDER), 300n)
  })

  it('reads a debit to zero, where the final amount field is absent', () => {
    assert.equal(holderDebit(meta({ MPTAmount: '250' }, {}), ID, HOLDER), 250n)
  })

  it('returns zero when the amount did not change or the holder is not affected', () => {
    assert.equal(holderDebit(meta({ Flags: 1 }, { MPTAmount: '5' }), ID, HOLDER), 0n)
    assert.equal(holderDebit(meta({ MPTAmount: '10' }, {}), ID, ISSUER), 0n)
  })
})

describe('FileBanRegistry', () => {
  it('persists bans durably and ignores duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bans-'))
    try {
      const path = join(dir, 'nested', 'bans.json')
      const registry = new FileBanRegistry(path)
      assert.equal(await registry.get(ID, HOLDER), undefined)
      const record = { issuanceId: ID, address: HOLDER, reason: 'sanctions', bannedAt: '2026-01-01T00:00:00.000Z' }
      await Promise.all([registry.add(record), registry.add({ ...record, reason: 'dup' })])

      const reopened = new FileBanRegistry(path)
      assert.deepEqual(await reopened.get(ID, HOLDER), record)
      assert.equal(await reopened.get('FF'.repeat(24), HOLDER), undefined)
      assert.equal((JSON.parse(await readFile(path, 'utf8')) as unknown[]).length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
