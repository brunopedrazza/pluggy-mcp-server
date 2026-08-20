/**
 * Capability probe for Pluggy's Connector 200 (MeuPluggy).
 *
 * Answers empirically the three unknowns that block the tool design:
 *   1. Which products does Connector 200 actually deliver (investments? bills? loans?)
 *   2. Do transaction dates arrive at UTC midnight, or do they carry a real time?
 *   3. Are categories returned in English or Portuguese?
 *
 * Prints no sensitive data: no account numbers, no tax IDs, no transaction
 * descriptions. Only counts, field presence, and category names.
 *
 * Usage:  npm run probe        (reads .env)
 */
import { PluggyClient } from 'pluggy-sdk'

const { PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_IDS } = process.env

if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET || !PLUGGY_ITEM_IDS) {
  console.error('Missing PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET and/or PLUGGY_ITEM_IDS.')
  console.error('Copy .env.example to .env and fill it in, or pass them as environment variables.')
  process.exit(1)
}

const itemIds = PLUGGY_ITEM_IDS.split(',').map((s) => s.trim()).filter(Boolean)
const client = new PluggyClient({ clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET })

const heading = (t: string) => console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`)
const yesNo = (b: boolean) => (b ? 'yes' : 'no')

// Pluggy returns real instants, not UTC-midnight calendar dates, so the calendar
// day has to be resolved in the account's own time zone. Slicing the ISO string
// puts late-evening transactions on the following day.
const SAO_PAULO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The calendar date the account holder would recognise. */
const calendarDate = (d: Date) => SAO_PAULO.format(d)

/** Detects whether the instant carries a real time (not UTC midnight). */
const hasTimeComponent = (d: Date) =>
  d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0

/** True when naive ISO slicing would report a different day than Sao Paulo does. */
const utcDayDiffers = (d: Date) => d.toISOString().slice(0, 10) !== calendarDate(d)

/** The Pluggy SDK throws plain objects, not Errors, so String(e) yields "[object Object]". */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    const parts = [o['code'], o['codeDescription'], o['message']].filter(Boolean)
    if (parts.length > 0) return parts.join(' ')
    return JSON.stringify(e)
  }
  return String(e)
}

async function tryFetch<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    console.log(`  ${label}: ERROR -> ${describeError(e)}`)
    return null
  }
}

for (const itemId of itemIds) {
  heading(`ITEM ${itemId.slice(0, 8)}...`)

  const item = await tryFetch('fetchItem', () => client.fetchItem(itemId))
  if (!item) continue

  console.log(`  connector      : ${item.connector?.name} (id ${item.connector?.id})`)
  console.log(`  status         : ${item.status} / execution ${item.executionStatus}`)
  console.log(`  lastUpdatedAt  : ${item.lastUpdatedAt ? new Date(item.lastUpdatedAt).toISOString() : 'never'}`)
  if (item.error) console.log(`  error          : ${item.error.code} - ${item.error.message}`)

  // --- Unknown 1: which products exist, via statusDetail ------------------
  console.log('\n  PRODUCTS (statusDetail):')
  const detail = item.statusDetail as Record<
    string,
    { isUpdated: boolean; lastUpdatedAt: string | null } | null
  > | null
  if (!detail) {
    console.log('    statusDetail absent - inferring from the calls below.')
  } else {
    for (const [product, info] of Object.entries(detail)) {
      if (!info) {
        console.log(`    ${product.padEnd(18)} -> not available`)
        continue
      }
      console.log(
        `    ${product.padEnd(18)} -> isUpdated=${yesNo(info.isUpdated)}  lastUpdatedAt=${info.lastUpdatedAt ?? '-'}`,
      )
    }
  }

  // --- Accounts -----------------------------------------------------------
  const accounts = await tryFetch('fetchAccounts', () => client.fetchAccounts(itemId))
  const accountList = accounts?.results ?? []
  console.log(`\n  ACCOUNTS: ${accountList.length}`)
  for (const a of accountList) {
    console.log(`    ${a.type}/${a.subtype ?? '-'}  balance=${a.balance} ${a.currencyCode}`)
  }

  // --- Unknowns 2 and 3: dates and categories -----------------------------
  const dateFrom = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10)
  let withTime = 0
  let utcMismatch = 0
  let total = 0
  let withCardMetadata = 0
  let withInstallments = 0
  let withPaymentData = 0
  let withMerchant = 0
  let withoutCategory = 0
  const categories = new Set<string>()
  const sampleTimestamps: string[] = []

  for (const a of accountList) {
    // v1 /transactions returns 410 Gone; v2 is cursor-based and uses dateFrom/dateTo.
    const page = await tryFetch(`fetchTransactionsCursor(${a.type})`, () =>
      client.fetchTransactionsCursor(a.id, { dateFrom }),
    )
    for (const t of page?.results ?? []) {
      total++
      const d = new Date(t.date)
      if (hasTimeComponent(d)) withTime++
      if (utcDayDiffers(d)) {
        utcMismatch++
        if (sampleTimestamps.length < 3) {
          sampleTimestamps.push(`${d.toISOString()} -> UTC ${d.toISOString().slice(0, 10)} vs SP ${calendarDate(d)}`)
        }
      }
      if (t.category) categories.add(t.category)
      else withoutCategory++
      if (t.creditCardMetadata) {
        withCardMetadata++
        const totalInstallments = t.creditCardMetadata.totalInstallments
        if (totalInstallments && totalInstallments > 1) withInstallments++
      }
      if (t.paymentData) withPaymentData++
      if (t.merchant) withMerchant++
    }
  }

  console.log(`\n  TRANSACTIONS (last 180d, first cursor page per account): ${total}`)
  console.log(`    carrying a real time       : ${withTime}/${total}`)
  console.log(
    `    ISO slicing would misdate  : ${utcMismatch}/${total}  ${utcMismatch ? '<<< must resolve dates in America/Sao_Paulo' : ''}`,
  )
  for (const sample of sampleTimestamps) console.log(`      ${sample}`)
  console.log(`    with creditCardMetadata    : ${withCardMetadata}`)
  console.log(`    in installments (>1)       : ${withInstallments}`)
  console.log(`    with paymentData (PIX/TED) : ${withPaymentData}`)
  console.log(`    with merchant              : ${withMerchant}`)
  console.log(`    without a category         : ${withoutCategory}`)
  console.log(`    distinct categories (${categories.size}):`)
  console.log(`      ${[...categories].slice(0, 25).join(' | ') || '(none)'}`)

  // --- Extra products -----------------------------------------------------
  const investments = await tryFetch('fetchInvestments', () => client.fetchInvestments(itemId))
  console.log(`\n  INVESTMENTS: ${investments ? investments.results.length : 'unavailable'}`)
  if (investments?.results.length) {
    const types = new Set(investments.results.map((i) => `${i.type}/${i.subtype ?? '-'}`))
    console.log(`    types: ${[...types].join(', ')}`)
    const first = investments.results[0]
    if (first) {
      const moves = await tryFetch('fetchInvestmentTransactions', () =>
        client.fetchInvestmentTransactions(first.id),
      )
      console.log(`    transactions on the first investment: ${moves ? moves.results.length : 'unavailable'}`)
    }
  }

  const loans = await tryFetch('fetchLoans', () => client.fetchLoans(itemId))
  console.log(`  LOANS: ${loans ? loans.results.length : 'unavailable'}`)

  const creditAccounts = accountList.filter((a) => a.type === 'CREDIT')
  console.log(`  CREDIT CARD BILLS: ${creditAccounts.length} credit account(s)`)
  for (const a of creditAccounts) {
    const bills = await tryFetch('fetchCreditCardBills', () => client.fetchCreditCardBills(a.id))
    if (!bills) continue
    console.log(`    ${bills.results.length} bill(s)`)
    for (const b of bills.results.slice(0, 3)) {
      const closing = b.billClosingDate ? calendarDate(new Date(b.billClosingDate)) : '-'
      console.log(
        `      due ${calendarDate(new Date(b.dueDate))}  closing ${closing}  total ${b.totalAmount}  payments ${b.payments?.length ?? 0}`,
      )
    }
  }
}

heading('END')
console.log('Paste this output into the conversation. It contains no account numbers, tax IDs, or transaction descriptions.')
