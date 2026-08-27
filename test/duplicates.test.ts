import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Investment } from 'pluggy-sdk'

import { collapseDuplicates, suspectDuplicates } from '../src/pluggy/duplicates.ts'

const ISIN = 'BRSTNCXXXX01'

/** Shaped after the four rows connector 200 returned for one Treasury bond. */
function position(fields: Record<string, unknown> & { id: string }): Investment {
  return {
    name: 'Tesouro IPCA+ 20XX',
    type: 'FIXED_INCOME',
    subtype: 'TREASURY',
    currencyCode: 'BRL',
    isin: ISIN,
    code: ISIN,
    dueDate: new Date('2032-08-15T03:00:00.000Z'),
    createdAt: new Date('2026-08-27T11:28:30.128Z'),
    updatedAt: new Date('2026-08-27T11:28:30.128Z'),
    ...fields,
  } as unknown as Investment
}

/** The two lots the owner actually holds, priced as of the last real sync. */
const REAL_5_12 = position({
  id: '907f806c-929b-4582-8a83-551d2e215a0b',
  quantity: 3,
  balance: 4500,
  amountOriginal: 4400,
  value: 1500,
  taxes: 20,
  purchaseDate: new Date('2026-07-08T03:00:00.000Z'),
  date: new Date('2026-08-26T21:55:49.000Z'),
})

const REAL_5_09 = position({
  id: '95e35d7e-f988-4e74-9a13-8a94b6fea9e5',
  quantity: 2.5,
  balance: 3750,
  amountOriginal: 3700,
  value: 1500,
  taxes: 15,
  purchaseDate: new Date('2026-07-31T03:00:00.000Z'),
  date: new Date('2026-08-26T21:55:49.000Z'),
})

/**
 * The pair the connector emitted twice during the item's first sync: identical
 * down to the unit price, one second apart on `date`.
 */
const COPY_FIELDS = {
  quantity: 2.5,
  balance: 3700,
  amountOriginal: 3700,
  value: 1480,
  taxes: 0,
  purchaseDate: new Date('2026-08-03T03:00:00.000Z'),
}

const COPY_A = position({
  ...COPY_FIELDS,
  id: '5c579814-023f-44d1-9f83-69dc16b1824a',
  date: new Date('2026-08-27T11:25:00.000Z'),
})

const COPY_B = position({
  ...COPY_FIELDS,
  id: '4120e145-c40b-4fd7-9d6f-f7cd7e32b8d2',
  date: new Date('2026-08-27T11:25:01.000Z'),
  createdAt: new Date('2026-08-27T11:28:30.156Z'),
})

/**
 * Connector 200 re-emits a position under a fresh id and never retires the old
 * row, so the same holding is returned twice and every total that sums positions
 * carries the copy. Seen on two banks: an LTN duplicated eight days apart and
 * this bond duplicated one second apart.
 */
describe('positions the connector reported twice', () => {
  it('drops a copy that differs only in when Pluggy saw it', () => {
    const { kept, removed } = collapseDuplicates([REAL_5_12, REAL_5_09, COPY_A, COPY_B])

    assert.equal(removed.length, 1, 'exactly one of the identical pair is a copy')
    assert.equal(removed[0]!.id, COPY_B.id, 'the later row is the one dropped')
    assert.deepEqual(
      kept.map((i) => i.id),
      [REAL_5_12.id, REAL_5_09.id, COPY_A.id],
      'input order survives, so the row that stays is stable across syncs',
    )
  })

  it('keeps rows that differ in anything describing the holding', () => {
    const { kept, removed } = collapseDuplicates([REAL_5_12, REAL_5_09])

    assert.equal(removed.length, 0)
    assert.equal(kept.length, 2, 'two genuine lots of the same bond are two positions')
  })

  /**
   * The rejected rule was "a position with no investment transactions is not
   * real". Movement history is barely reported through Open Finance: on this
   * data 26 of 41 genuine positions on one item expose none, and *both* copies
   * of the duplicated LTN expose none, so that rule deletes real holdings. What
   * marks a copy is having a twin, not looking unloved.
   */
  it('keeps a lone position that carries every mark of a copy', () => {
    const { kept, removed } = collapseDuplicates([COPY_A])

    assert.equal(removed.length, 0, 'zero yield, zero tax and no movements do not make a row fake')
    assert.equal(kept.length, 1)
  })

  it('leaves an empty list alone', () => {
    const { kept, removed } = collapseDuplicates([])
    assert.deepEqual(kept, [])
    assert.deepEqual(removed, [])
  })
})

/**
 * What survives the collapse is still ambiguous: the copy that remains describes
 * the same 5.09 purchase as `REAL_5_09`, priced on a different day. Removing it
 * would mean guessing which of two different rows is real, and guessing wrong
 * hides money the owner holds. So it is reported instead.
 */
describe('positions that merely look alike', () => {
  it('flags same instrument, same quantity, same maturity', () => {
    const suspects = suspectDuplicates([REAL_5_12, REAL_5_09, COPY_A])

    assert.equal(suspects.length, 1, 'only the 5.09 rows share a signature')
    assert.equal(suspects[0]!.count, 2)
    assert.equal(suspects[0]!.name, 'Tesouro IPCA+ 20XX')
    assert.equal(suspects[0]!.currency, 'BRL')
    assert.equal(suspects[0]!.reason, 'same-contract')
    assert.equal(
      Number(suspects[0]!.balance.toFixed(2)),
      7450,
      'the reader is told how much the ambiguity is worth',
    )
  })

  it('does not flag lots of different size', () => {
    assert.deepEqual(suspectDuplicates([REAL_5_12, REAL_5_09]), [])
  })

  /**
   * These two rows read as two lots of the same paper bought months apart, at
   * 6.41% and 6.96%. The owner's app shows a single position. Rate and purchase
   * date were both tried as a way to tell lots from copies and both cleared this
   * pair, so neither is in the signature: a copy carries whatever the connector
   * stamped on it.
   */
  it('flags two rows of the same contract even when their rates differ', () => {
    const bond = (id: string, rate: number, purchaseDate: string) =>
      position({
        id,
        rate,
        name: 'NTNB PRINC',
        isin: 'BRSTNCXXXX02',
        code: 'BRSTNCXXXX02',
        quantity: 8,
        balance: 9600,
        dueDate: new Date('2035-05-15T03:00:00.000Z'),
        purchaseDate: new Date(purchaseDate),
      })

    const suspects = suspectDuplicates([
      bond('f778816d-e4ad-456f-b9e4-000000000000', 6.41, '2024-06-28T03:00:00.000Z'),
      bond('27f61216-a627-464d-82db-000000000000', 6.96, '2024-12-09T03:00:00.000Z'),
    ])

    assert.equal(suspects.length, 1)
    assert.equal(suspects[0]!.reason, 'same-contract')
    assert.equal(suspects[0]!.count, 2)
  })

  it('still flags copies that share a rate but not a purchase date', () => {
    const suspects = suspectDuplicates([
      position({ ...COPY_FIELDS, id: 'a', rate: 100, purchaseDate: new Date('2026-07-31T03:00:00.000Z') }),
      position({ ...COPY_FIELDS, id: 'b', rate: 100, purchaseDate: new Date('2026-08-03T03:00:00.000Z') }),
    ])

    assert.equal(suspects.length, 1, 'the copy was stamped with the settlement date, not the trade date')
  })

  it('says nothing about positions carrying no instrument identifier', () => {
    const unnamed = [
      position({ id: 'x', isin: null, code: null, quantity: 1, balance: 10 }),
      position({ id: 'y', isin: null, code: null, quantity: 1, balance: 10 }),
    ]
    assert.deepEqual(suspectDuplicates(unnamed), [], 'grouping by name alone would flag unrelated holdings')
  })

  it('says nothing about positions with no quantity', () => {
    const noQuantity = [
      position({ id: 'x', quantity: null, balance: 10 }),
      position({ id: 'y', quantity: null, balance: 20 }),
    ]
    assert.deepEqual(suspectDuplicates(noQuantity), [])
  })
})

/**
 * One item reports three `NTNB PRINC` rows at an identical quantity and unit
 * price, across two ISINs maturing six years apart. Two bonds of different
 * maturities cannot share a unit price to six decimals, so these figures were
 * copied rather than observed. Rule one cannot see it: the rows disagree on the
 * instrument, which is the first thing its signature keys on.
 */
describe('one position\'s figures wearing several identities', () => {
  const ntnb = (id: string, isin: string, rate: number, dueDate: string) =>
    position({
      id,
      isin,
      code: isin,
      rate,
      name: 'NTNB PRINC',
      quantity: 8,
      value: 1200,
      balance: 9600,
      dueDate: new Date(dueDate),
    })

  it('flags matching figures across different paper', () => {
    const suspects = suspectDuplicates([
      ntnb('a', 'BRSTNCXXXX02', 6.41, '2035-05-15T03:00:00.000Z'),
      ntnb('b', 'BRSTNCXXXX02', 6.96, '2035-05-15T03:00:00.000Z'),
      ntnb('c', 'BRSTNCXXXX03', 7.37, '2029-05-15T03:00:00.000Z'),
    ])

    const figures = suspects.filter((s) => s.reason === 'identical-figures')
    assert.equal(figures.length, 1)
    assert.equal(figures[0]!.count, 3)
    assert.equal(Number(figures[0]!.balance.toFixed(2)), 28800)
  })

  it('leaves a single instrument to the contract rule', () => {
    const suspects = suspectDuplicates([
      ntnb('a', 'BRSTNCXXXX02', 6.41, '2035-05-15T03:00:00.000Z'),
      ntnb('b', 'BRSTNCXXXX02', 6.96, '2035-05-15T03:00:00.000Z'),
    ])

    assert.equal(suspects.length, 1)
    assert.equal(suspects[0]!.reason, 'same-contract', 'one instrument is not figures wearing another identity')
  })

  it('ignores the zeroed rows a redeemed position leaves behind', () => {
    const redeemed = [
      position({ id: 'x', name: 'FUND11', quantity: 0, value: 0, balance: 0 }),
      position({ id: 'y', name: 'Fundo Simples FIRF', isin: null, code: null, quantity: 0, value: 0, balance: 0 }),
    ]
    assert.deepEqual(suspectDuplicates(redeemed), [], 'zero is not a figure worth matching on')
  })
})
