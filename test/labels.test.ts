import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Account } from 'pluggy-sdk'

import { Cache } from '../src/pluggy/cache.ts'
import { buildAccountLabels, deriveBankName } from '../src/pluggy/labels.ts'

/** Minimal stand-in: the label code only reads name, type, subtype and creditData. */
function account(partial: Partial<Account> & { id: string }): Account {
  return partial as unknown as Account
}

// Shapes taken from the three real connections the probe inspected.
const XP = [
  account({ id: 'a', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'XP' }),
  account({ id: 'b', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'XP' }),
  account({
    id: 'c',
    type: 'CREDIT',
    subtype: 'CREDIT_CARD',
    name: 'Cartão XP Visa Infinite',
    creditData: { brand: 'VISA', level: 'INFINITE' },
  } as Partial<Account> & { id: string }),
]

const NUBANK = [
  account({
    id: 'd',
    type: 'BANK',
    subtype: 'CHECKING_ACCOUNT',
    name: 'Nu Pagamentos S.A. - Instituição de Pagamento',
  }),
  account({
    id: 'e',
    type: 'CREDIT',
    subtype: 'CREDIT_CARD',
    name: 'platinum',
    creditData: { brand: 'MASTERCARD', level: 'PLATINUM' },
  } as Partial<Account> & { id: string }),
]

const INTER = [
  account({ id: 'f', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'BANCO INTER' }),
  account({
    id: 'g',
    type: 'CREDIT',
    subtype: 'CREDIT_CARD',
    name: 'BLACK',
    creditData: { brand: 'MASTERCARD', level: 'BLACK' },
  } as Partial<Account> & { id: string }),
]

describe('deriveBankName', () => {
  it('takes the bank name from the bank account, not the card', () => {
    assert.equal(deriveBankName(XP, 'fallback'), 'XP')
    assert.equal(deriveBankName(INTER, 'fallback'), 'Banco Inter')
  })

  it('strips legal boilerplate that costs tokens on every row', () => {
    assert.equal(deriveBankName(NUBANK, 'fallback'), 'Nu Pagamentos')
  })

  it('leaves short acronyms alone rather than title-casing them', () => {
    assert.equal(deriveBankName(XP, 'fallback'), 'XP')
  })

  it('falls back when an item exposes no usable account', () => {
    assert.equal(deriveBankName([], 'Conexao 524f2255'), 'Conexao 524f2255')
  })
})

describe('buildAccountLabels', () => {
  it('numbers duplicate accounts so two "XP" balances are distinguishable', () => {
    const labels = buildAccountLabels(XP, 'XP')
    assert.equal(labels.get('a'), 'XP Conta')
    assert.equal(labels.get('b'), 'XP Conta 2')
  })

  it('names cards by bank plus brand and level, not by the useless product name', () => {
    assert.equal(buildAccountLabels(XP, 'XP').get('c'), 'XP Visa Infinite')
    assert.equal(buildAccountLabels(NUBANK, 'Nu Pagamentos').get('e'), 'Nu Pagamentos Mastercard Platinum')
    // "BLACK" alone never said which bank it belonged to.
    assert.equal(buildAccountLabels(INTER, 'Banco Inter').get('g'), 'Banco Inter Mastercard Black')
  })
})

describe('Cache', () => {
  it('serves the cached value without reloading', async () => {
    const cache = new Cache()
    let calls = 0
    const load = async () => {
      calls++
      return 'value'
    }
    assert.equal(await cache.through('k', load), 'value')
    assert.equal(await cache.through('k', load), 'value')
    assert.equal(calls, 1)
  })

  it('collapses concurrent loads for the same key into one', async () => {
    const cache = new Cache()
    let calls = 0
    const load = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return calls
    }
    await Promise.all([cache.through('k', load), cache.through('k', load), cache.through('k', load)])
    assert.equal(calls, 1, 'three simultaneous tool calls must not trigger three statement sweeps')
  })

  it('evicts the previous version when the stamp changes', async () => {
    const cache = new Cache()
    const opts = { versionPrefix: 'item:tx:' }
    await cache.through('item:tx:2026-08-19', async () => 'old', opts)
    await cache.through('item:tx:2026-08-20', async () => 'new', opts)
    assert.equal(cache.size, 1, 'the pre-sync sweep must not stay resident')
  })

  it('never caches a failure', async () => {
    const cache = new Cache()
    await assert.rejects(cache.through('k', async () => Promise.reject(new Error('boom'))))
    assert.equal(await cache.through('k', async () => 'recovered'), 'recovered')
  })
})
