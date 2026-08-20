import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Transaction } from 'pluggy-sdk'

import { calendarDateFormatter, plainDateFormatter } from '../src/dates.ts'
import type { Connection } from '../src/pluggy/store.ts'
import {
  matchesBill,
  renderTransactionRow,
  toRows,
  TRANSACTION_HEADERS,
  type TransactionRow,
} from '../src/tools/common.ts'
import { unassignedNote } from '../src/tools/transactions.ts'
import { renderTsv, type Cell } from '../src/tsv.ts'

const TZ = 'America/Sao_Paulo'
const ctx = { day: calendarDateFormatter(TZ), plainDay: plainDateFormatter(TZ) }

function connection(): Connection {
  return {
    itemId: 'item',
    label: 'XP',
    status: 'UPDATED',
    executionStatus: null,
    lastUpdatedAt: null,
    error: null,
    healthy: true,
    accounts: [],
    accountLabels: new Map([
      ['card', 'XP Visa Infinite'],
      ['checking', 'XP Conta'],
    ]),
  }
}

/** Minimal stand-in: only the fields these two functions actually read. */
function transaction(partial: Partial<Transaction>): Transaction {
  return { type: 'DEBIT', ...partial } as unknown as Transaction
}

/** Looked up by name so reordering the columns cannot silently pass. */
function col(row: Cell[], name: string): Cell {
  const index = TRANSACTION_HEADERS.indexOf(name)
  assert.ok(index >= 0, `no column named ${name}`)
  return row[index]
}

function render(partial: Partial<Transaction>, bills?: Map<string, string>): Cell[] {
  const rows = toRows(connection(), [transaction({ accountId: 'card', ...partial })], bills)
  return renderTransactionRow(rows[0] as TransactionRow, ctx)
}

/**
 * The bug this file exists for.
 *
 * DESIGN.md once claimed `list_transactions` counted a purchase on the day it
 * happened, and the server instructions repeated it. Pluggy's `date` on a card
 * is the posting date, so the claim was false and every "spending this month"
 * total silently mixed instalments of year-old purchases into the figure.
 */
describe('credit card: posting date vs purchase date', () => {
  it('keeps the posting date in `date`, where every row has one', () => {
    // The shape a real row has: the 11th of 12 instalments, posted a few days
    // before the bill closes, for a purchase made nearly a year earlier.
    const row = render({
      date: new Date('2026-07-26T12:00:00.000Z'),
      description: 'LOJA EXEMPLO',
      amount: 250,
      creditCardMetadata: {
        installmentNumber: 11,
        totalInstallments: 12,
        purchaseDate: new Date('2025-09-01T00:00:00.000Z'),
      },
    })

    assert.equal(col(row, 'date'), '2026-07-26')
    assert.equal(col(row, 'parc'), '11/12')
    assert.equal(col(row, 'amount'), '-250.00')
  })

  it('surfaces the purchase date when the two views diverge', () => {
    const row = render({
      date: new Date('2026-07-26T12:00:00.000Z'),
      amount: 250,
      creditCardMetadata: {
        installmentNumber: 11,
        totalInstallments: 12,
        purchaseDate: new Date('2025-09-01T00:00:00.000Z'),
      },
    })

    assert.equal(col(row, 'data_compra'), '2025-09-01')
  })

  it('leaves the purchase date empty when it matches the posting date', () => {
    // Sparse on purpose: empty means "same as `date`", never "unknown".
    const row = render({
      date: new Date('2026-08-18T17:00:00.000Z'),
      amount: 120,
      creditCardMetadata: { purchaseDate: new Date('2026-08-18T00:00:00.000Z') },
    })

    assert.equal(col(row, 'date'), '2026-08-18')
    assert.equal(col(row, 'data_compra'), '')
  })

  it('leaves it empty on a bank row, which has no purchase date at all', () => {
    const row = render({ accountId: 'checking', date: new Date('2026-08-18T17:00:00.000Z'), amount: 50 })
    assert.equal(col(row, 'data_compra'), '')
  })

  it('leaves total_compra empty when the connector omits the purchase total', () => {
    // These connectors return `totalAmount` as null on every instalment row, so
    // an empty cell here is the normal case rather than a fault.
    const row = render({
      date: new Date('2026-07-26T12:00:00.000Z'),
      amount: 250,
      creditCardMetadata: { installmentNumber: 11, totalInstallments: 12 },
    })

    assert.equal(col(row, 'parc'), '11/12')
    assert.equal(col(row, 'total_compra'), '')
  })

  it('renders the purchase total when a connector does send it', () => {
    const row = render({
      date: new Date('2026-07-26T12:00:00.000Z'),
      amount: 250,
      creditCardMetadata: { installmentNumber: 11, totalInstallments: 12, totalAmount: 3000 },
    })

    assert.equal(col(row, 'total_compra'), '-3000.00')
  })

  it('does not call a one-off purchase an instalment', () => {
    const row = render({
      date: new Date('2026-08-18T17:00:00.000Z'),
      amount: 120,
      creditCardMetadata: { installmentNumber: 1, totalInstallments: 1 },
    })

    assert.equal(col(row, 'parc'), '')
  })
})

describe('credit card: which bill a row landed on', () => {
  const bills = new Map([['bill-uuid', '2026-08-05']])

  it('resolves the opaque bill uuid to the due date the bill tool prints', () => {
    const row = render(
      { date: new Date('2026-07-26T12:00:00.000Z'), amount: 250, creditCardMetadata: { billId: 'bill-uuid' } },
      bills,
    )

    assert.equal(col(row, 'fatura'), '2026-08-05')
  })

  it('marks a still-open bill as a forecast, never as a due date', () => {
    const row = render(
      { date: new Date('2026-08-18T17:00:00.000Z'), amount: 120, creditCardMetadata: { billForecastDate: '2026-09' } },
      bills,
    )

    assert.equal(col(row, 'fatura'), '~2026-09')
  })

  it('prefers the settled bill over the forecast when both are present', () => {
    const row = render(
      {
        date: new Date('2026-07-26T12:00:00.000Z'),
        amount: 250,
        creditCardMetadata: { billId: 'bill-uuid', billForecastDate: '2026-08' },
      },
      bills,
    )

    assert.equal(col(row, 'fatura'), '2026-08-05')
  })

  it('degrades to empty rather than guessing when bills could not be loaded', () => {
    const row = render({
      date: new Date('2026-07-26T12:00:00.000Z'),
      amount: 250,
      creditCardMetadata: { billId: 'bill-uuid' },
    })

    assert.equal(col(row, 'fatura'), '')
  })

  it('is empty on a bank row', () => {
    const row = render({ accountId: 'checking', date: new Date('2026-08-18T17:00:00.000Z'), amount: 50 })
    assert.equal(col(row, 'fatura'), '')
  })
})

describe('matchesBill', () => {
  const row = (bill: string) => ({ bill }) as TransactionRow

  it('finds a settled bill by its month', () => {
    assert.ok(matchesBill(row('2026-08-05'), '2026-08'))
  })

  it('matches an exact due date', () => {
    assert.ok(matchesBill(row('2026-08-05'), '2026-08-05'))
  })

  it('selects an open bill by the forecast value the column prints', () => {
    assert.ok(matchesBill(row('~2026-08'), '~2026-08'))
  })

  it('does not match a different month', () => {
    assert.ok(!matchesBill(row('2026-08-05'), '2026-07'))
  })

  /**
   * The regression that this whole column exists to prevent, found on real data:
   * asking for the bill due 2026-08-05 also returned every August purchase,
   * which sits on the bill that closes in August. Two statements, one total,
   * belonging to neither.
   */
  it('never merges an open bill into the due date that shares its prefix', () => {
    assert.ok(!matchesBill(row('~2026-08'), '2026-08-05'))
    assert.ok(!matchesBill(row('~2026-08'), '2026-08'))
    assert.ok(!matchesBill(row('2026-08-05'), '~2026-08'))
  })

  it('lets a bare month select the bill due that month', () => {
    assert.ok(matchesBill(row('2026-08-05'), '2026-08'))
  })

  it('does not treat a month as a prefix of an unrelated year', () => {
    assert.ok(!matchesBill(row('2026-08-05'), '2026-0'))
  })

  it('never matches a row with no bill, whatever the filter', () => {
    // Guards the prefix comparison: every string starts with the empty string,
    // so bank rows would otherwise join to every bill.
    assert.ok(!matchesBill(row(''), '2026-08-05'))
    assert.ok(!matchesBill(row(''), ''))
  })
})

/**
 * `amount` on a foreign row is the converted value, which is right but does not
 * match the receipt or the statement line the person is holding. `valor_orig`
 * keeps the original charge visible so the row can still be checked, without
 * ever being a number that belongs in a sum.
 */
describe('valor_orig', () => {
  it('prints the original charge so the row can be checked against a receipt', () => {
    const row = render({
      date: new Date('2026-07-23T12:00:00.000Z'),
      amount: 50,
      amountInAccountCurrency: 250,
      currencyCode: 'USD',
    })

    assert.equal(col(row, 'amount'), '-250.00')
    assert.equal(col(row, 'valor_orig'), '50.00 USD')
  })

  it('leaves valor_orig empty on a domestic row, which has nothing to reconcile', () => {
    const row = render({
      date: new Date('2026-08-18T17:00:00.000Z'),
      amount: 120,
      amountInAccountCurrency: 120,
      currencyCode: 'BRL',
    })

    assert.equal(col(row, 'valor_orig'), '')
  })
})

describe('forecast periods that cannot be a bill', () => {
  it('drops the 0001-01 Pluggy actually returned rather than printing it', () => {
    const row = render({
      date: new Date('2026-08-18T17:00:00.000Z'),
      amount: 120,
      creditCardMetadata: { billForecastDate: '0001-01' },
    })

    assert.equal(col(row, 'fatura'), '')
  })

  it('drops a month that does not exist', () => {
    const row = render({
      date: new Date('2026-08-18T17:00:00.000Z'),
      amount: 120,
      creditCardMetadata: { billForecastDate: '2026-13' },
    })

    assert.equal(col(row, 'fatura'), '')
  })

  it('keeps a plausible one', () => {
    const row = render({
      date: new Date('2026-08-18T17:00:00.000Z'),
      amount: 120,
      creditCardMetadata: { billForecastDate: '2026-09' },
    })

    assert.equal(col(row, 'fatura'), '~2026-09')
  })
})

/**
 * A bill query silently omitting rows is the failure this server refuses
 * everywhere else. One real charge comes back with no bill id and the forecast
 * `0001-01`, so it belongs to no bill at all: correct in a period query, absent
 * from every bill view, and worth real money that nothing on screen accounts for.
 */
describe('rows that belong to no bill', () => {
  const card = (bill: string, amount: number): TransactionRow =>
    ({ bill, amount, transaction: transaction({ creditCardMetadata: {} }) }) as TransactionRow
  const bank = (amount: number): TransactionRow =>
    ({ bill: '', amount, transaction: transaction({ creditCardMetadata: null }) }) as TransactionRow

  it('says nothing when every card row has a bill', () => {
    assert.equal(unassignedNote([card('2026-08-05', -10), card('~2026-09', -20)]), undefined)
  })

  it('does not mistake a bank row for an orphan', () => {
    // Bank rows have no bill and never will; only card rows can go missing.
    assert.equal(unassignedNote([bank(-500), card('2026-08-05', -10)]), undefined)
  })

  it('warns with the count and the value that is missing from the view', () => {
    const note = unassignedNote([card('2026-08-05', -10), card('', -80), card('', -120)])
    assert.ok(note, 'expected a warning')
    assert.match(note[0] as string, /SEM FATURA: 2 /)
    assert.match(note[0] as string, /200\.00/)
  })

  it('warns before the grid, where it cannot be skimmed past', () => {
    const out = renderTsv(['date', 'amount'], [['2026-08-18', '-10.00']], {
      notes: unassignedNote([card('', -80)]),
    })
    assert.ok(out.indexOf('SEM FATURA') < out.indexOf('date\tamount'))
  })
})
