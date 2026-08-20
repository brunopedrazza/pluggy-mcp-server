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
 */
export function signedAmount(transaction: Transaction): number {
  const magnitude = Math.abs(transaction.amount)
  return transaction.type === 'DEBIT' ? -magnitude : magnitude
}

export const TRANSACTION_HEADERS = ['date', 'desc', 'amount', 'parc', 'total_compra', 'category', 'account']

export type TransactionRow = {
  transaction: Transaction
  connection: Connection
  accountLabel: string
  amount: number
  date: Date
}

/** Flattens one connection's transactions into rows carrying their label. */
export function toRows(connection: Connection, transactions: Transaction[]): TransactionRow[] {
  return transactions.map((transaction) => ({
    transaction,
    connection,
    accountLabel: connection.accountLabels.get(transaction.accountId) ?? connection.label,
    amount: signedAmount(transaction),
    date: new Date(transaction.date),
  }))
}

export function renderTransactionRow(row: TransactionRow, day: ToolContext['day']): Cell[] {
  const meta = row.transaction.creditCardMetadata
  const total = meta?.totalInstallments ?? 0
  const current = meta?.installmentNumber ?? 0
  const installment = total > 1 && current > 0 ? `${current}/${total}` : ''
  // Only meaningful alongside an instalment: it is the whole purchase, while
  // `amount` is the slice charged this month.
  const purchaseTotal = installment && meta?.totalAmount != null ? money(-Math.abs(meta.totalAmount)) : ''

  return [
    day(row.date),
    sanitize(row.transaction.description || row.transaction.descriptionRaw),
    money(row.amount),
    installment,
    purchaseTotal,
    row.transaction.category ?? '',
    row.accountLabel,
  ]
}

/** Newest first, which is the order a person reads a statement in. */
export function byDateDesc(a: TransactionRow, b: TransactionRow): number {
  return b.date.getTime() - a.date.getTime()
}

/**
 * Loads transactions from every healthy connection, already labelled.
 * Degraded connections are reported separately so callers can warn.
 */
export async function collectTransactions(
  ctx: ToolContext,
  connectionFilter?: string,
): Promise<{ rows: TransactionRow[]; missing: Awaited<ReturnType<PluggyStore['resolve']>>['missing'] }> {
  const { healthy, missing } = await ctx.store.resolve(connectionFilter)
  const perConnection = await Promise.all(
    healthy.map(async (connection) => toRows(connection, await ctx.store.transactions(connection))),
  )
  return { rows: perConnection.flat().sort(byDateDesc), missing }
}
