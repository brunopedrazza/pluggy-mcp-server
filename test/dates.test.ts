import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calendarDateFormatter, parsePeriod, zonedToInstant } from '../src/dates.ts'

const TZ = 'America/Sao_Paulo'
const day = calendarDateFormatter(TZ)

describe('calendar dates', () => {
  it('resolves late-evening instants to the local day, not the UTC one', () => {
    // These are real samples from the probe. Slicing the ISO string reports the
    // day after, which is how 4.3% of transactions ended up in the wrong month.
    assert.equal(day('2026-08-17T00:46:07.390Z'), '2026-08-16')
    assert.equal(day('2026-08-14T02:21:57.781Z'), '2026-08-13')
    assert.equal(day('2026-07-30T00:54:15.684Z'), '2026-07-29')
  })

  it('keeps the day for instants that are already local midnight', () => {
    // One bank returns 03:00Z, which IS midnight in Sao Paulo.
    assert.equal(day('2026-06-16T03:00:00.000Z'), '2026-06-16')
  })

  it('keeps the day for ordinary daytime instants', () => {
    assert.equal(day('2026-08-06T17:19:03.000Z'), '2026-08-06')
  })
})

describe('zonedToInstant', () => {
  it('maps local midnight to 03:00Z', () => {
    assert.equal(zonedToInstant(TZ, 2026, 3, 1).toISOString(), '2026-03-01T03:00:00.000Z')
  })
})

describe('parsePeriod', () => {
  it('bounds a month at local midnight on both ends', () => {
    const p = parsePeriod('2026-03', TZ)
    assert.equal(p.from.toISOString(), '2026-03-01T03:00:00.000Z')
    assert.equal(p.to.toISOString(), '2026-04-01T02:59:59.999Z')
  })

  it('excludes a transaction that is March in UTC but February locally', () => {
    const p = parsePeriod('2026-03', TZ)
    const borderline = new Date('2026-03-01T00:30:00.000Z') // 28 Feb 21:30 in Sao Paulo
    assert.equal(day(borderline), '2026-02-28')
    assert.ok(borderline < p.from, 'must fall outside the March window')
  })

  it('handles a full year', () => {
    const p = parsePeriod('2026', TZ)
    assert.equal(day(p.from), '2026-01-01')
    assert.equal(day(p.to), '2026-12-31')
  })

  it('handles February in a leap year', () => {
    const p = parsePeriod('2028-02', TZ)
    assert.equal(day(p.to), '2028-02-29')
  })

  it('handles an explicit range inclusively', () => {
    const p = parsePeriod('2026-03-01..2026-04-15', TZ)
    assert.equal(day(p.from), '2026-03-01')
    assert.equal(day(p.to), '2026-04-15')
  })

  it('handles relative windows', () => {
    assert.equal(parsePeriod('last90d', TZ).label, 'last 90 days')
    assert.equal(parsePeriod('last6m', TZ).label, 'last 6 months')
    assert.equal(parsePeriod('last2y', TZ).label, 'last 2 years')
  })

  it('defaults to 90 days when unspecified', () => {
    assert.equal(parsePeriod(undefined, TZ).label, 'last 90 days')
  })

  it('rejects nonsense rather than guessing', () => {
    assert.throws(() => parsePeriod('março', TZ), /Unrecognised period/)
    assert.throws(() => parsePeriod('2026-13', TZ), /Invalid month/)
    assert.throws(() => parsePeriod('2026-05-01..2026-04-01', TZ), /ends before it starts/)
  })
})
