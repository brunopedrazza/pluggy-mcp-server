/**
 * `list_credit_card_bills`, `list_investments`, `list_investment_transactions`
 * and `list_loans`.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'

import type { CreditCardBills } from 'pluggy-sdk'

import { money } from '../money.ts'
import { sanitize } from '../redact.ts'
import { capRows, renderTsv } from '../tsv.ts'
import {
  holdingCurrency,
  INVESTMENT_HEADERS,
  INVESTMENT_TRANSACTION_HEADERS,
  READ_ONLY,
  text,
  type ToolContext,
} from './common.ts'

/**
 * Interest, late fees and annuity charged straight onto the bill.
 *
 * These never appear as transactions, so without them a bill total that exceeds
 * the sum of its rows looks like missing data rather than a finance charge.
 * Types are kept alongside the amount because "is this interest or the annual
 * fee?" is the whole question a surprising total raises.
 */
function financeCharges(charges: CreditCardBills['financeCharges']): { total: number; types: string } {
  // A connector reports a zero-amount `OTHER` charge on bills that carry none.
  // Naming a type beside an empty amount reads as a value that failed to load,
  // so a charge of nothing is treated as no charge.
  const items = (charges ?? []).filter((charge) => Math.abs(charge.amount) > 0)
  const total = items.reduce((sum, charge) => sum + Math.abs(charge.amount), 0)
  const types = [...new Set(items.map((charge) => charge.type))].join(' ')
  return { total, types }
}

function rate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return ''
  // Pluggy reports rates as fractions (0.1234 = 12.34%).
  return `${(value * 100).toFixed(2)}%`
}

export function registerHoldingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_credit_card_bills',
    {
      title: 'List credit card bills',
      description:
        'Closed and open credit card bills: due date, closing date, total charged, what was paid, and any finance charges. `due` joins to the `fatura` column of list_transactions, so `list_transactions({ bill: "2026-09-05" })` returns the line items behind one of these rows. `charges` is interest, late fees and annuity recorded on the bill header, and `charge_types` names them. Whether they also appear among the line items depends on the connector - one of these cards emits its IOF both ways - so check the rows before adding `charges` to them, or the charge is counted twice. Gaps in either direction survive on some bills; report the difference rather than presenting the reconciliation as exact.',
      inputSchema: z.object({
        connection: z.string().optional().describe('Restrict to one bank, matched on the connection label.'),
        count: z.number().int().positive().optional().describe('How many recent bills per card. Defaults to 12.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ connection, count }) => {
      const { healthy, missing } = await ctx.store.resolve(connection)
      const limit = count ?? 12
      const rows: (string | number)[][] = []

      for (const c of healthy) {
        for (const account of c.accounts.filter((a) => a.type === 'CREDIT')) {
          const bills = await ctx.store.bills(c, account.id)
          const recent = [...bills]
            .sort((a, b) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime())
            .slice(0, limit)
          for (const bill of recent) {
            const paid = (bill.payments ?? []).reduce((sum, p) => sum + Math.abs(p.amount), 0)
            const charges = financeCharges(bill.financeCharges)
            rows.push([
              c.accountLabels.get(account.id) ?? c.label,
              ctx.plainDay(bill.dueDate),
              ctx.plainDay(bill.billClosingDate),
              money(bill.totalAmount),
              money(bill.minimumPaymentAmount),
              paid > 0 ? money(paid) : '',
              charges.total > 0 ? money(charges.total) : '',
              charges.types,
            ])
          }
        }
      }

      return text(
        renderTsv(['card', 'due', 'closing', 'total', 'minimum', 'paid', 'charges', 'charge_types'], rows, { missing }),
      )
    },
  )

  server.registerTool(
    'list_investments',
    {
      title: 'List investments',
      description:
        'Current investment positions across every connected institution: balance, profit so far, and reported rates. This is a snapshot of today, not a history - to see contributions and withdrawals use list_investment_transactions. `profit` is what the institution reports as accumulated gain, which is not the same as a time-weighted return. `balance` and `profit` are in the position\'s own currency, given in `currency`: an offshore brokerage reports USD alongside Brazilian positions in BRL, so group by `currency` before totalling and never add across currencies without converting and saying so.',
      inputSchema: z.object({
        connection: z.string().optional().describe('Restrict to one bank, matched on the connection label.'),
        type: z.string().optional().describe('Restrict to one type, for example FIXED_INCOME, EQUITY or MUTUAL_FUND.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ connection, type }) => {
      const { healthy, missing } = await ctx.store.resolve(connection)
      const rows: (string | number)[][] = []

      for (const c of healthy) {
        for (const investment of await ctx.store.investments(c)) {
          if (type && investment.type !== type.toUpperCase()) continue
          rows.push([
            sanitize(investment.name, 44),
            `${investment.type}/${investment.subtype ?? '-'}`,
            money(investment.balance),
            holdingCurrency(investment.currencyCode),
            money(investment.amountProfit),
            rate(investment.annualRate),
            rate(investment.lastTwelveMonthsRate),
            ctx.plainDay(investment.dueDate),
            c.label,
          ])
        }
      }

      const { rows: capped, truncated } = capRows(rows, ctx.config.maxRows)
      return text(
        renderTsv(INVESTMENT_HEADERS, capped, {
          truncated,
          missing,
        }),
      )
    },
  )

  server.registerTool(
    'list_investment_transactions',
    {
      title: 'List investment transactions',
      description:
        'Contributions, withdrawals and other movements inside investments. Needed to reason about returns, since a balance alone cannot tell a gain from a deposit. Coverage is sparse: many institutions expose no movement history through Open Finance, and an empty result means "not reported", never "no contributions". `amount` and `value` are in the position\'s own currency, given in `currency`; never add across currencies without converting and saying so.',
      inputSchema: z.object({
        connection: z.string().optional().describe('Restrict to one bank, matched on the connection label.'),
        investment: z.string().optional().describe('Restrict to investments whose name contains this text.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ connection, investment }) => {
      const { healthy, missing } = await ctx.store.resolve(connection)
      const needle = investment?.trim().toLowerCase()
      const rows: (string | number)[][] = []
      let inspected = 0

      for (const c of healthy) {
        for (const holding of await ctx.store.investments(c)) {
          if (needle && !holding.name.toLowerCase().includes(needle)) continue
          inspected++
          for (const movement of await ctx.store.investmentTransactions(c, holding.id)) {
            rows.push([
              ctx.day(movement.date),
              sanitize(holding.name, 36),
              movement.type ?? '',
              money(movement.amount),
              movement.quantity ?? '',
              money(movement.value),
              holdingCurrency(holding.currencyCode),
              c.label,
            ])
          }
        }
      }

      rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])))
      const { rows: capped, truncated } = capRows(rows, ctx.config.maxRows)
      const body = renderTsv(INVESTMENT_TRANSACTION_HEADERS, capped, {
        truncated,
        missing,
      })

      if (rows.length === 0 && inspected > 0) {
        return text(
          `${body}\n\nNota: ${inspected} investimento(s) consultado(s), nenhum expoe historico de movimentacao. Isso significa "nao reportado pela instituicao", nao "sem aportes" - nao conclua rentabilidade zero a partir disto.`,
        )
      }
      return text(body)
    },
  )

  server.registerTool(
    'list_loans',
    {
      title: 'List loans',
      description:
        'Loans and financing: outstanding contract amount, total cost (CET), and instalment schedule. Needed to answer whether paying a debt down beats investing. An empty result may mean the institution does not expose loans through this connection rather than that none exist.',
      inputSchema: z.object({
        connection: z.string().optional().describe('Restrict to one bank, matched on the connection label.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ connection }) => {
      const { healthy, missing } = await ctx.store.resolve(connection)
      const rows: (string | number)[][] = []

      for (const c of healthy) {
        for (const loan of await ctx.store.loans(c)) {
          const paid = loan.installments?.paidInstallments ?? ''
          const total = loan.installments?.totalNumberOfInstallments ?? ''
          rows.push([
            sanitize(loan.productName, 40),
            ctx.plainDay(loan.contractDate),
            money(loan.contractAmount),
            rate(loan.CET),
            paid !== '' && total !== '' ? `${paid}/${total}` : '',
            ctx.plainDay(loan.dueDate),
            c.label,
          ])
        }
      }

      return text(
        renderTsv(['product', 'contracted', 'amount', 'cet', 'installments', 'due', 'bank'], rows, { missing }),
      )
    },
  )
}
