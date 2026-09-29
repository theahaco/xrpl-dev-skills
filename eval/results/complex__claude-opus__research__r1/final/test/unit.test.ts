import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { decodeMPTokenMetadata, type TransactionMetadata } from 'xrpl'

import {
  DYNAMIC_MPT_IMMUTABLE_FLAGS,
  InMemoryBanRegistry,
  InvalidArgumentError,
  IssuanceConfigError,
  JsonFileBanRegistry,
  MAX_MPT_AMOUNT,
  MPTokenIssuanceFlags,
  assertSafeIssuance,
  issuanceCreateTransaction,
  mptIssuanceId,
  outstandingAmountChange,
  parsePositiveAmount,
  type IssuanceState,
} from '../src/index.js'

const ISSUER = 'rpU7Z5LY6FPCp4AQxyFwUCTsGaKYdf6ZqK'
const METADATA = {
  ticker: 'TUSD',
  name: 'Test USD',
  icon: 'example.com/icon.png',
  asset_class: 'rwa',
  asset_subclass: 'stablecoin',
  issuer_name: 'Example Issuer',
}

describe('parsePositiveAmount', () => {
  it('accepts bigints and integer strings', () => {
    assert.equal(parsePositiveAmount(1n), 1n)
    assert.equal(parsePositiveAmount('500'), 500n)
    assert.equal(parsePositiveAmount(MAX_MPT_AMOUNT.toString()), MAX_MPT_AMOUNT)
  })

  it('rejects zero, negatives, decimals, exponents, leading zeros, numbers and overflow', () => {
    for (const bad of ['0', '-1', '1.5', '1e3', '007', '', ' 1', '0x10', (MAX_MPT_AMOUNT + 1n).toString()]) {
      assert.throws(() => parsePositiveAmount(bad), InvalidArgumentError, bad)
    }
    assert.throws(() => parsePositiveAmount(0n), InvalidArgumentError)
    assert.throws(() => parsePositiveAmount(-5n), InvalidArgumentError)
    assert.throws(() => parsePositiveAmount(5 as unknown as string), InvalidArgumentError)
  })
})

describe('issuanceCreateTransaction', () => {
  it('enables require-auth, lock, clawback and transfer, and nothing that escapes the controls', () => {
    const tx = issuanceCreateTransaction(ISSUER, { metadata: METADATA }, false)
    assert.equal(tx.Flags, 0x04 | 0x02 | 0x40 | 0x20)
    assert.equal(tx.AssetScale, 0)
    assert.equal(tx.ImmutableFlags, undefined)
    assert.equal(tx.TransferFee, undefined)
    assert.equal(tx.MaximumAmount, undefined)
    assert.deepEqual(decodeMPTokenMetadata(tx.MPTokenMetadata ?? ''), METADATA)
  })

  it('omits transfer when canTransfer is false and locks configuration when asked', () => {
    const tx = issuanceCreateTransaction(ISSUER, { metadata: METADATA, canTransfer: false, maximumAmount: '1000' }, true)
    assert.equal(tx.Flags, 0x04 | 0x02 | 0x40)
    assert.equal(tx.ImmutableFlags, DYNAMIC_MPT_IMMUTABLE_FLAGS)
    assert.equal(tx.MaximumAmount, '1000')
  })

  it('rejects invalid options', () => {
    assert.throws(() => issuanceCreateTransaction(ISSUER, { metadata: METADATA, transferFee: 10, canTransfer: false }, false), InvalidArgumentError)
    assert.throws(() => issuanceCreateTransaction(ISSUER, { metadata: METADATA, transferFee: 50_001 }, false), InvalidArgumentError)
    assert.throws(() => issuanceCreateTransaction(ISSUER, { metadata: METADATA, assetScale: 1.5 }, false), InvalidArgumentError)
    assert.throws(() => issuanceCreateTransaction(ISSUER, { metadata: { ...METADATA, ticker: 'lower' } }, false), InvalidArgumentError)
  })
})

describe('assertSafeIssuance', () => {
  const safe: IssuanceState = {
    issuanceId: '00000001' + '0'.repeat(40),
    issuer: ISSUER,
    flags: 0x04 | 0x02 | 0x40 | 0x20,
    globallyFrozen: false,
    outstandingAmount: 0n,
    maximumAmount: MAX_MPT_AMOUNT,
    assetScale: 0,
    transferFee: 0,
    immutableFlags: 0,
    domainId: undefined,
  }

  it('accepts a correctly configured issuance, locked or not', () => {
    assertSafeIssuance(safe, ISSUER)
    assertSafeIssuance({ ...safe, flags: safe.flags | MPTokenIssuanceFlags.lsfMPTLocked, globallyFrozen: true }, ISSUER)
  })

  it('rejects wrong issuer, missing controls, escape hatches and domains', () => {
    assert.throws(() => assertSafeIssuance(safe, 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'), IssuanceConfigError)
    for (const flag of [MPTokenIssuanceFlags.lsfMPTRequireAuth, MPTokenIssuanceFlags.lsfMPTCanLock, MPTokenIssuanceFlags.lsfMPTCanClawback]) {
      assert.throws(() => assertSafeIssuance({ ...safe, flags: safe.flags & ~flag }, ISSUER), IssuanceConfigError)
    }
    for (const flag of [MPTokenIssuanceFlags.lsfMPTCanEscrow, MPTokenIssuanceFlags.lsfMPTCanTrade, MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance]) {
      assert.throws(() => assertSafeIssuance({ ...safe, flags: safe.flags | flag }, ISSUER), IssuanceConfigError)
    }
    assert.throws(() => assertSafeIssuance({ ...safe, domainId: 'AB'.repeat(32) }, ISSUER), IssuanceConfigError)
  })
})

describe('mptIssuanceId / outstandingAmountChange', () => {
  const id = mptIssuanceId(0x0123abcd, 'rrrrrrrrrrrrrrrrrrrrrhoLvTp')

  it('builds sequence || account ID', () => {
    assert.equal(id, '0123ABCD' + '0'.repeat(40))
  })

  const meta = (previous: string | undefined, final: string, sequence = 0x0123abcd): TransactionMetadata =>
    ({
      TransactionIndex: 0,
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [
        { ModifiedNode: { LedgerEntryType: 'AccountRoot', LedgerIndex: 'X', FinalFields: {}, PreviousFields: {} } },
        {
          ModifiedNode: {
            LedgerEntryType: 'MPTokenIssuance',
            LedgerIndex: 'Y',
            FinalFields: { Issuer: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', Sequence: sequence, OutstandingAmount: final },
            PreviousFields: previous === undefined ? {} : { OutstandingAmount: previous },
          },
        },
      ],
    }) as unknown as TransactionMetadata

  it('reports issuance (+) and clawback (-) deltas', () => {
    assert.equal(outstandingAmountChange(meta('100', '600'), id), 500n)
    assert.equal(outstandingAmountChange(meta('1000', '700'), id), -300n)
  })

  it('reports zero when unchanged or for another issuance', () => {
    assert.equal(outstandingAmountChange(meta(undefined, '600'), id), 0n)
    assert.equal(outstandingAmountChange(meta('100', '600', 7), id), 0n)
  })
})

describe('ban registries', () => {
  it('in-memory registry is idempotent', async () => {
    const registry = new InMemoryBanRegistry()
    await registry.add({ address: 'rA', bannedAt: 't1', reason: 'first' })
    await registry.add({ address: 'rA', bannedAt: 't2' })
    assert.equal(await registry.isBanned('rA'), true)
    assert.equal(await registry.isBanned('rB'), false)
    assert.deepEqual(await registry.list(), [{ address: 'rA', bannedAt: 't1', reason: 'first' }])
  })

  it('JSON file registry persists, survives concurrent adds, and fails closed on corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bans-'))
    const path = join(dir, 'nested', 'bans.json')
    const registry = new JsonFileBanRegistry(path)
    assert.equal(await registry.isBanned('rA'), false)
    await Promise.all(['rA', 'rB', 'rC', 'rA'].map(async (address) => registry.add({ address, bannedAt: 't' })))
    const reopened = new JsonFileBanRegistry(path)
    assert.deepEqual((await reopened.list()).map((record) => record.address).sort(), ['rA', 'rB', 'rC'])
    assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 3)

    await writeFile(path, '{"not":"a list"}')
    await assert.rejects(reopened.isBanned('rA'), /corrupt/)
  })
})
