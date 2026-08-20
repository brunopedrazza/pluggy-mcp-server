import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Transaction } from 'pluggy-sdk'

import { signedAmount } from '../src/tools/common.ts'

/** Minimal stand-in: signedAmount reads only type and the two amounts. */
function transaction(partial: Partial<Transaction>): Transaction {
  return partial as unknown as Transaction
}

/**
 * Pluggy denominates `amount` in the currency of the purchase, so a foreign
 * charge was being reported as if the number were reais. The error runs in both
 * directions at once - a dollar charge lands far too low, a peso charge far too
 * high - which is why it never showed up as a suspicious bias in any total.
 */
describe('signedAmount', () => {
  const usd = (partial: Partial<Transaction> = {}) =>
    transaction({ type: 'DEBIT', amount: 50, amountInAccountCurrency: 250, currencyCode: 'USD', ...partial })

  it('reports the account currency, not the currency of the purchase', () => {
    // A dollar subscription that reads 50 and cost R$250.
    assert.equal(signedAmount(usd()), -250)
  })

  it('converts in the other direction too', () => {
    // A peso restaurant bill that reads 60,000 and cost R$240.
    const ars = transaction({ type: 'DEBIT', amount: 60000, amountInAccountCurrency: 240, currencyCode: 'ARS' })
    assert.equal(signedAmount(ars), -240)
  })

  it('takes the sign from `type`, which is the field that stays consistent', () => {
    assert.equal(signedAmount(usd({ type: 'CREDIT' })), 250)
  })

  it('falls back to `amount` when there is no converted value', () => {
    assert.equal(signedAmount(usd({ amountInAccountCurrency: null })), -50)
  })

  it('leaves a domestic row untouched', () => {
    const brl = transaction({ type: 'DEBIT', amount: 120, amountInAccountCurrency: null, currencyCode: 'BRL' })
    assert.equal(signedAmount(brl), -120)
  })

  it('renders a card debit negative, against Pluggy’s raw positive', () => {
    // The sign normalisation this function has always done, kept under test now
    // that the magnitude no longer comes straight from `amount`.
    const card = transaction({ type: 'DEBIT', amount: 120, amountInAccountCurrency: null, currencyCode: 'BRL' })
    assert.ok(signedAmount(card) < 0)
  })
})
