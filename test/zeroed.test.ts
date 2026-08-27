import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Investment, InvestmentTransaction } from 'pluggy-sdk'

import { zeroedDespitePurchases } from '../src/pluggy/zeroed.ts'

function position(fields: Record<string, unknown>): Investment {
  return { name: 'ETF11', currencyCode: 'BRL', status: 'TOTAL_WITHDRAWAL', balance: 0, ...fields } as unknown as Investment
}

function movement(type: string, amount: number): InvestmentTransaction {
  return { type, amount } as unknown as InvestmentTransaction
}

/**
 * The four zeroed positions across two items, which the rule has to separate:
 * two funds carrying no movement history at all, a CDB genuinely redeemed, and
 * one live ETF that the connector reports as zero.
 */
describe('a zeroed position the institution contradicts', () => {
  it('raises the one holding purchases with no sale against them', () => {
    const found = zeroedDespitePurchases(position({}), [movement('BUY', 1200)])

    assert.ok(found, 'a purchase and no sale, against a zero balance, is a contradiction')
    assert.equal(found.name, 'ETF11')
    assert.equal(found.purchased, 1200)
    assert.equal(found.currency, 'BRL')
  })

  it('stays quiet when sales cover the purchases', () => {
    const redeemed = zeroedDespitePurchases(position({ name: 'CDB' }), [
      movement('BUY', 1000),
      movement('SELL', 400),
      movement('SELL', 350),
      movement('SELL', 300),
    ])

    assert.equal(redeemed, null, 'sales exceeding the purchases are a redeemed position')
  })

  /**
   * The load-bearing case. Movement history barely travels through Open Finance,
   * so silence can never be read as evidence - both genuinely empty funds report
   * nothing at all, and treating that as a contradiction would warn about every
   * redeemed position on the account.
   */
  it('never raises a position that reports no movements', () => {
    assert.equal(zeroedDespitePurchases(position({ name: 'Fundo Simples FIRF' }), []), null)
    assert.equal(zeroedDespitePurchases(position({ name: 'FUND11' }), []), null)
  })

  it('ignores a position that still has a balance', () => {
    const alive = zeroedDespitePurchases(position({ balance: 500 }), [movement('BUY', 400)])
    assert.equal(alive, null, 'a position carrying a balance is not missing from the total')
  })

  it('reports only the purchases a partial sale left unmatched', () => {
    const partial = zeroedDespitePurchases(position({}), [movement('BUY', 800), movement('SELL', 300)])

    assert.ok(partial)
    assert.equal(partial.purchased, 500)
  })

  it('reads amounts by magnitude, whichever sign the connector uses', () => {
    const negatives = zeroedDespitePurchases(position({}), [movement('BUY', -800), movement('SELL', -300)])

    assert.ok(negatives)
    assert.equal(negatives.purchased, 500)
  })

  it('is not fooled by movements of other kinds', () => {
    const other = zeroedDespitePurchases(position({}), [movement('TRANSFER', 700)])
    assert.equal(other, null, 'only a reported purchase justifies contradicting a zero')
  })
})
