import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  holdingCurrency,
  INVESTMENT_HEADERS,
  INVESTMENT_TRANSACTION_HEADERS,
} from '../src/tools/common.ts'

/**
 * Every position was BRL until an offshore brokerage was connected. Six USD
 * holdings then joined the same table as the Brazilian ones with nothing to
 * tell them apart, and the `saude_financeira` prompt adds investments straight
 * into net worth — so a dollar balance was about to be counted as reais, wrong
 * by roughly the exchange rate and entirely plausible on the page.
 */
describe('investment rows carry their currency', () => {
  it('exposes currency next to the money it describes', () => {
    assert.deepEqual(INVESTMENT_HEADERS.slice(2, 5), ['balance', 'currency', 'profit'])
    assert.deepEqual(INVESTMENT_TRANSACTION_HEADERS.slice(5, 7), ['value', 'currency'])
  })

  it('reports what the institution reported', () => {
    assert.equal(holdingCurrency('USD'), 'USD')
    assert.equal(holdingCurrency('EUR'), 'EUR')
    assert.equal(holdingCurrency('BRL'), 'BRL')
  })

  it('falls back to BRL only when the currency is absent', () => {
    assert.equal(holdingCurrency(null), 'BRL')
    assert.equal(holdingCurrency(undefined), 'BRL')
  })

  it('keeps a currency column in both tables, so neither can be summed blind', () => {
    for (const headers of [INVESTMENT_HEADERS, INVESTMENT_TRANSACTION_HEADERS]) {
      assert.ok(headers.includes('currency'), `${headers.join(',')} must expose currency`)
    }
  })
})
