/**
 * Shared plumbing for the tools.
 */
import type { Transaction } from 'pluggy-sdk'

import type { Config } from '../config.ts'
import { money } from '../money.ts'
import type { Connection, PluggyStore } from '../pluggy/store.ts'
import { sanitize } from '../redact.ts'
import type { Cell } from '../tsv.ts'

export type ToolContext = {
  config: Config
  store: PluggyStore
  /** Transaction timestamps: real instants, converted to the configured zone. */
  day: (value: Date | string) => string
  /** Declared calendar fields (due dates, contract dates) that must not shift. */
  plainDay: (value: Date | string | null | undefined) => string
}

export function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

/** Every tool but `refresh_connection` only reads. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }

/**
 * Normalises the sign so negative always means money leaving the account.
 *
 * Pluggy's raw `amount` is signed from the account's own perspective, and the
 * two account types disagree. Measured across all six real accounts:
 *
 *   BANK   DEBIT  -1338.00   CREDIT  +2000.00
 *   CREDIT DEBIT   +188.16   CREDIT  -4860.40
 *
 * A card purchase is positive while a bank purchase is negative, so summing raw
 * amounts over a mixed set makes card spending cancel bank spending. `type` is
 * the field that is actually consistent, so it drives the sign.
 *
 * The resulting ledger is coherent double-entry: paying a card bill appears as a
 * debit on the bank and a credit on the card, which cancel, leaving true
 * spending when everything is summed together.
 *
 * The magnitude comes from `amountInAccountCurrency` whenever Pluggy provides
 * it, because `amount` is denominated in the currency of the purchase. A small
 * minority of rows on a Brazilian card are USD or ARS, and reading those as
 * reais is wrong in both directions at once: a dollar subscription lands about
 * five times too cheap, a peso restaurant bill hundreds of times too expensive.
 * Neither looks like a consistent bias, so no total ever reads as wrong enough
 * to question. Every BRL row that carries the field agrees with `amount` to the
 * cent, so preferring it is safe as well as correct.
 */
export function signedAmount(transaction: Transaction): number {
  const magnitude = Math.abs(transaction.amountInAccountCurrency ?? transaction.amount)
  return transaction.type === 'DEBIT' ? -magnitude : magnitude
}

/**
 * The purchase as the merchant charged it, when that was another currency.
 *
 * Printed only for foreign rows, where `amount` alone cannot be reconciled
 * against a receipt or a statement line.
 */
export function originalAmount(transaction: Transaction): string {
  if (transaction.amountInAccountCurrency == null) return ''
  if (!transaction.currencyCode || transaction.currencyCode === 'BRL') return ''
  return `${money(Math.abs(transaction.amount))} ${transaction.currencyCode}`
}

/**
 * Pluggy returned `0001-01` as a forecast period on a real row, which would
 * print as the perfectly plausible-looking bill `~0001-01`. A forecast that
 * cannot be a bill is worth less than no forecast at all.
 */
const FORECAST_PERIOD = /^20\d{2}-(0[1-9]|1[0-2])$/

function forecastBill(period: string | undefined): string {
  return period && FORECAST_PERIOD.test(period) ? `~${period}` : ''
}

export const TRANSACTION_HEADERS = [
  'date',
  'data_compra',
  'desc',
  'amount',
  'parc',
  'total_compra',
  'valor_orig',
  'fatura',
  'category',
  'account',
]

export type TransactionRow = {
  transaction: Transaction
  connection: Connection
  accountLabel: string
  amount: number
  /**
   * The posting date - when the charge hit the account. On a credit card this
   * is not the purchase date: an instalment of a purchase made a year ago posts
   * today. `creditCardMetadata.purchaseDate` carries the original date, and
   * `renderTransactionRow` prints it whenever the two differ.
   */
  date: Date
  /**
   * Which bill this landed on, as the bill's due date - the same string
   * `list_credit_card_bills` prints in its `due` column, so the two tools join
   * on it. Empty on bank accounts.
   *
   * While a bill is still open Pluggy offers only a forecast *period*, which is
   * rendered `~YYYY-MM`. The tilde is not decoration: a purchase forecast to
   * `2026-08` sits on the bill that closes in August, while `2026-08-05` is the
   * due date of the bill that closed in July. The two share a prefix and are
   * different bills, so an unmarked forecast invites exactly the merge this
   * column exists to prevent.
   */
  bill: string
}

/**
 * Flattens one connection's transactions into rows carrying their label.
 *
 * `billDueDates` maps Pluggy's opaque bill uuid onto the due date, because a
 * uuid is not something a person or a model can join on. When a card is not
 * covered by the map - the bill is still open, or the connector never returned
 * bills - Pluggy's own forecast period stands in.
 */
export function toRows(
  connection: Connection,
  transactions: Transaction[],
  billDueDates: ReadonlyMap<string, string> = new Map(),
): TransactionRow[] {
  return transactions.map((transaction) => {
    const meta = transaction.creditCardMetadata
    const due = meta?.billId ? billDueDates.get(meta.billId) : undefined
    return {
      transaction,
      connection,
      accountLabel: connection.accountLabels.get(transaction.accountId) ?? connection.label,
      amount: signedAmount(transaction),
      date: new Date(transaction.date),
      bill: due ?? forecastBill(meta?.billForecastDate),
    }
  })
}

export function renderTransactionRow(
  row: TransactionRow,
  ctx: Pick<ToolContext, 'day' | 'plainDay'>,
): Cell[] {
  const meta = row.transaction.creditCardMetadata
  const total = meta?.totalInstallments ?? 0
  const current = meta?.installmentNumber ?? 0
  const installment = total > 1 && current > 0 ? `${current}/${total}` : ''
  // Only meaningful alongside an instalment: it is the whole purchase, while
  // `amount` is the slice charged this month. Several connectors leave it null,
  // so an instalment row with an empty `total_compra` is normal.
  const purchaseTotal = installment && meta?.totalAmount != null ? money(-Math.abs(meta.totalAmount)) : ''

  const posted = ctx.day(row.date)
  // A declared calendar date, like a due date: formatted without shifting zones.
  const purchased = meta?.purchaseDate ? ctx.plainDay(meta.purchaseDate) : ''
  // Printed only when it disagrees with the posting date, which is exactly when
  // the purchase view and the bill view diverge. Empty means "same as `date`",
  // never "unknown", so a purchase-dated sum can fall back to `date` per row.
  const purchaseDate = purchased && purchased !== posted ? purchased : ''

  return [
    posted,
    purchaseDate,
    sanitize(row.transaction.description || row.transaction.descriptionRaw),
    money(row.amount),
    installment,
    purchaseTotal,
    originalAmount(row.transaction),
    row.bill,
    row.transaction.category ?? '',
    row.accountLabel,
  ]
}

/** Newest first, which is the order a person reads a statement in. */
export function byDateDesc(a: TransactionRow, b: TransactionRow): number {
  return b.date.getTime() - a.date.getTime()
}

/**
 * Maps every known bill uuid on a connection onto its due date.
 *
 * Bills are a secondary lookup here, so a connector that fails to serve them
 * must not take the statement down with it: on failure the map is simply empty
 * and `fatura` degrades to Pluggy's forecast period.
 */
async function billDueDates(ctx: ToolContext, connection: Connection): Promise<Map<string, string>> {
  const cards = connection.accounts.filter((account) => account.type === 'CREDIT')
  const perCard = await Promise.all(
    cards.map(async (account) => {
      try {
        return await ctx.store.bills(connection, account.id)
      } catch {
        return []
      }
    }),
  )
  return new Map(perCard.flat().map((bill) => [bill.id, ctx.plainDay(bill.dueDate)]))
}

/**
 * Loads transactions from every healthy connection, already labelled and linked
 * to the bill each one landed on. Degraded connections are reported separately
 * so callers can warn.
 */
export async function collectTransactions(
  ctx: ToolContext,
  connectionFilter?: string,
): Promise<{ rows: TransactionRow[]; missing: Awaited<ReturnType<PluggyStore['resolve']>>['missing'] }> {
  const { healthy, missing } = await ctx.store.resolve(connectionFilter)
  const perConnection = await Promise.all(
    healthy.map(async (connection) => {
      const [transactions, bills] = await Promise.all([
        ctx.store.transactions(connection),
        billDueDates(ctx, connection),
      ])
      return toRows(connection, transactions, bills)
    }),
  )
  return { rows: perConnection.flat().sort(byDateDesc), missing }
}

const BILL_MONTH = /^\d{4}-\d{2}$/

/**
 * Matches a row against a `fatura` filter.
 *
 * Deliberately strict. An earlier version compared prefixes in both directions,
 * which quietly merged the bill due `2026-08-05` with the still-open one
 * forecast as `2026-08` - two different statements that happen to share four
 * characters, producing a total belonging to neither.
 *
 * So: an exact `fatura` value always matches, and the one convenience is that a
 * bare `YYYY-MM` selects the bill *due* in that month. It cannot reach a
 * forecast row, because a forecast carries the `~` marker and a due date never
 * does; asking for an open bill means passing `~YYYY-MM` as the column prints
 * it. A card has at most one bill due per month, so neither form can merge two.
 */
export function matchesBill(row: TransactionRow, needle: string): boolean {
  if (!row.bill) return false
  const wanted = needle.trim()
  if (row.bill === wanted) return true
  return BILL_MONTH.test(wanted) && row.bill.startsWith(`${wanted}-`)
}
