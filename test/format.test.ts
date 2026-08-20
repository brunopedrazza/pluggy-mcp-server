import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { money, round2 } from '../src/money.ts'
import { sanitize } from '../src/redact.ts'
import { capRows, renderTsv } from '../src/tsv.ts'

describe('money', () => {
  it('rounds the four-decimal bill totals Pluggy actually returns', () => {
    // Real values from the probe, on the account with foreign-currency activity.
    assert.equal(money(2431.5285), '2431.53')
    assert.equal(money(4200.6489), '4200.65')
    assert.equal(money(1757.082), '1757.08')
  })

  it('always renders two decimals', () => {
    assert.equal(money(4860.4), '4860.40')
    assert.equal(money(0), '0.00')
  })

  it('rounds half away from zero, symmetrically for debits and credits', () => {
    assert.equal(round2(0.005), 0.01)
    assert.equal(round2(-0.005), -0.01)
  })

  it('renders absent values as empty, never as "null"', () => {
    assert.equal(money(null), '')
    assert.equal(money(undefined), '')
    assert.equal(money(Number.NaN), '')
  })
})

describe('sanitize', () => {
  it('strips control characters that would break the TSV grid', () => {
    assert.equal(sanitize('PIX\tRECEBIDO\nJOAO'), 'PIX RECEBIDO JOAO')
  })

  it('strips bidirectional overrides used to disguise text', () => {
    assert.equal(sanitize('PAGAMENTO‮reverso'), 'PAGAMENTOreverso')
  })

  it('collapses runs of whitespace', () => {
    assert.equal(sanitize('  MERCADO     LIVRE  '), 'MERCADO LIVRE')
  })

  it('truncates long descriptions', () => {
    const out = sanitize('x'.repeat(200), 20)
    assert.equal(out.length, 20)
    assert.ok(out.endsWith('…'))
  })

  it('returns empty for absent input', () => {
    assert.equal(sanitize(null), '')
    assert.equal(sanitize(undefined), '')
  })
})

describe('renderTsv', () => {
  const headers = ['date', 'desc', 'amount']
  const rows = [['2026-03-14', 'IFOOD', '-64.90']]

  it('puts the truncation warning before the header row', () => {
    const out = renderTsv(headers, rows, { truncated: { shown: 800, total: 1847 } })
    const warningAt = out.indexOf('PARCIAL')
    const headerAt = out.indexOf('date\tdesc')
    assert.ok(warningAt >= 0 && warningAt < headerAt, 'warning must precede the grid')
    assert.match(out, /1847/)
    assert.match(out, /NAO some/)
  })

  it('puts the missing-connection warning before the header row', () => {
    const out = renderTsv(headers, rows, {
      missing: [{ label: 'Inter', status: 'LOGIN_ERROR', since: '2026-08-02' }],
    })
    assert.ok(out.indexOf('INCOMPLETO') < out.indexOf('date\tdesc'))
    assert.match(out, /Inter: LOGIN_ERROR desde 2026-08-02/)
  })

  it('neutralises tabs inside a value so columns cannot shift', () => {
    const out = renderTsv(headers, [['2026-03-14', 'A\tB', '-1.00']])
    const dataLine = out.split('\n').at(-1) ?? ''
    assert.equal(dataLine.split('\t').length, 3)
  })

  it('says so explicitly when there are no rows', () => {
    const out = renderTsv(headers, [])
    assert.match(out, /Nenhum resultado/)
    assert.ok(!out.includes('date\tdesc'), 'a lone header reads as "zero spending"')
  })
})

describe('capRows', () => {
  it('reports the true total when it cuts', () => {
    const { rows, truncated } = capRows(Array.from({ length: 1847 }, (_, i) => i), 800)
    assert.equal(rows.length, 800)
    assert.deepEqual(truncated, { shown: 800, total: 1847 })
  })

  it('does not flag truncation when everything fits', () => {
    const { rows, truncated } = capRows([1, 2, 3], 800)
    assert.equal(rows.length, 3)
    assert.equal(truncated, undefined)
  })
})
