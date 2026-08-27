/**
 * Positions the connector reports more than once.
 *
 * Connector 200 re-emits a position under a fresh `id` on some syncs and never
 * retires the old row, so the same holding is returned twice and every total
 * that sums positions is inflated by the copy. Observed on two different banks:
 * an LTN duplicated eight days apart, and a Treasury bond duplicated one second
 * apart during an item's first sync.
 *
 * The tempting rule — "a position with no investment transactions is not real" —
 * is wrong and dangerous here. Movement history is barely reported through Open
 * Finance at all: on this data 26 of 41 genuine positions on one item expose no
 * transactions, and *both* copies of the duplicated LTN expose none, so that rule
 * would delete a real holding while leaving other duplicates untouched. An empty
 * transaction list means "not reported", never "did not happen".
 *
 * What actually marks a copy is that it is a copy: identical in every field that
 * describes the holding, differing only in the fields that describe when Pluggy
 * saw it. Collapsing those is provable rather than heuristic — no judgement is
 * made about which of two *different* rows deserves to live.
 *
 * Rows that merely look alike are reported instead of removed (see
 * `suspectDuplicates`). Silently dropping a position the owner really holds is a
 * worse failure than showing one they do not.
 */
import type { Investment } from 'pluggy-sdk'

/**
 * Fields recording when Pluggy observed the position rather than what it is.
 *
 * `date` belongs here: the two copies of the same first-sync position differed
 * by one second on it, because it carries the sync clock rather than a position
 * date on that connector.
 */
const OBSERVATION_FIELDS: ReadonlySet<string> = new Set(['id', 'createdAt', 'updatedAt', 'date'])

/** Every field describing the holding itself, order-independent. */
function signature(investment: Investment): string {
  const entries = Object.entries(investment as unknown as Record<string, unknown>)
    .filter(([key]) => !OBSERVATION_FIELDS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries)
}

/**
 * Drops positions identical to one already seen, keeping the first.
 *
 * Input order is preserved so the surviving row is stable across syncs.
 */
export function collapseDuplicates(investments: Investment[]): { kept: Investment[]; removed: Investment[] } {
  const seen = new Set<string>()
  const kept: Investment[] = []
  const removed: Investment[] = []

  for (const investment of investments) {
    const key = signature(investment)
    if (seen.has(key)) removed.push(investment)
    else {
      seen.add(key)
      kept.push(investment)
    }
  }

  return { kept, removed }
}

export type SuspectGroup = {
  /** The instrument's name, for the reader. */
  name: string
  /** How many surviving rows share the signature. */
  count: number
  /** What those rows add up to, which is what an inflated total would carry. */
  balance: number
  currency: string
  /** Which signature matched, so the note can say what was actually observed. */
  reason: 'same-contract' | 'identical-figures'
}

/**
 * Near-duplicates: same instrument, same quantity, same maturity, different row.
 *
 * These are reported, never removed. Two rows can legitimately look like this —
 * the same bond bought twice in the same size is an ordinary thing to hold — so
 * the only safe move is to put the ambiguity in front of the reader. Requires a
 * real instrument identifier: grouping by name alone would flag every position
 * an institution declines to name properly.
 *
 * Contracted rate and purchase date are deliberately *not* in the signature. Both
 * were tried and both were wrong. The XP item reports two rows of the same NTN-B
 * Principal maturing 2035, differing only in rate (6.41% against 6.96%) and
 * purchase date, which reads exactly like two lots bought months apart — the
 * owner's app shows a single position. A copy carries whatever the connector
 * stamped it with, so keying on either field silences the duplicate it was meant
 * to catch. Quantity, maturity and instrument are enough: two rows agreeing on
 * those are worth a question, and asking is all this does.
 */
export function suspectDuplicates(investments: Investment[]): SuspectGroup[] {
  const suspects: SuspectGroup[] = []
  const reported = new Set<string>()

  const describe = (group: Investment[], reason: SuspectGroup['reason']): void => {
    const membership = group
      .map((i) => i.id)
      .sort()
      .join(',')
    if (reported.has(membership)) return
    reported.add(membership)
    suspects.push({
      name: group[0]!.name,
      count: group.length,
      balance: group.reduce((sum, i) => sum + (i.balance ?? 0), 0),
      currency: group[0]!.currencyCode ?? 'BRL',
      reason,
    })
  }

  for (const candidate of groupBy(investments, contractKey).values()) {
    if (candidate.length > 1) describe(candidate, 'same-contract')
  }

  // Rule two catches what rule one cannot: rows the connector filled with one
  // position's figures under several contract identities. Requires more than one
  // instrument in the group, so a genuine pair of identical lots stays with rule
  // one rather than being reported twice.
  for (const candidate of groupBy(investments, figureKey).values()) {
    if (candidate.length < 2) continue
    const instruments = new Set(candidate.map((i) => i.isin ?? i.code ?? i.name))
    if (instruments.size > 1) describe(candidate, 'identical-figures')
  }

  return suspects
}

function groupBy(investments: Investment[], key: (i: Investment) => string | null): Map<string, Investment[]> {
  const groups = new Map<string, Investment[]>()
  for (const investment of investments) {
    const k = key(investment)
    if (k === null) continue
    const existing = groups.get(k)
    if (existing) existing.push(investment)
    else groups.set(k, [investment])
  }
  return groups
}

/** Same paper, same size, same maturity. */
function contractKey(investment: Investment): string | null {
  const instrument = investment.isin ?? investment.code
  if (!instrument || investment.quantity === null || investment.quantity === undefined) return null
  return [instrument, investment.quantity, investment.type, investment.subtype ?? '', investment.dueDate ?? '']
    .map(String)
    .join('|')
}

/**
 * Same size, same unit price, same balance — whatever the paper says it is.
 *
 * Two bonds of different maturities cannot share a unit price to six decimal
 * places; one item here reports three rows of the same treasury bond at an
 * identical quantity and identical unit price, across two ISINs maturing six
 * years apart, which no market produces.
 *
 * What this catches is not a duplicated row but duplicated *figures*: checked
 * against the institution's own app, the shorter-dated position exists and is
 * worth materially more than reported, because the connector filled it with the
 * longer-dated row's numbers. The row is real and its balance is fiction, so the
 * warning is about the arithmetic being unusable, not about a row that should go.
 */
function figureKey(investment: Investment): string | null {
  const { quantity, value, balance } = investment
  if (quantity === null || quantity === undefined || !quantity) return null
  if (value === null || value === undefined || !value) return null
  if (balance === null || balance === undefined || !balance) return null
  return [quantity, value, balance].map(String).join('|')
}
