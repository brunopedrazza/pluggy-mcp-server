/**
 * Positions the connector zeroed while the money is still there.
 *
 * The mirror of `duplicates.ts`, and the more dangerous half. A duplicated row
 * inflates a total, which at least looks like something once someone checks. A
 * position stamped `TOTAL_WITHDRAWAL` with a zero balance contributes nothing to
 * any sum and appears in the table as a harmless `0.00` — the money does not look
 * wrong, it looks absent. One ETF here reads as zero while the institution's own
 * app shows a live four-figure holding, with a single purchase recorded against
 * it and no sale.
 *
 * The test is deliberately built on evidence being *present*, never absent. Open
 * Finance barely reports investment movements, so "no sale was reported" proves
 * nothing on its own and can never raise a warning here. What raises one is a
 * purchase the connector itself reported, with no sale of its own to offset it,
 * against a balance of zero. Across the four zeroed positions on this account
 * that separates them exactly: two carry no movements at all and stay quiet, a
 * genuinely redeemed CDB carries sales that cover its purchases and stays quiet,
 * and only the ETF is raised.
 *
 * Nothing here estimates what the position is worth. The purchase amount is
 * reported as what was paid, not as a balance: inventing a current value from a
 * historical trade is precisely the quietly-wrong number this server exists to
 * avoid.
 */
import type { Investment, InvestmentTransaction } from 'pluggy-sdk'

export type ZeroedPosition = {
  name: string
  /** Purchases the connector reported with no sale of its own against them. */
  purchased: number
  currency: string
}

/**
 * Reports a zeroed position contradicted by the connector's own movements.
 *
 * Returns null when the position is zero for any reason this cannot disprove,
 * which is the common and correct case.
 */
export function zeroedDespitePurchases(
  investment: Investment,
  movements: InvestmentTransaction[],
): ZeroedPosition | null {
  if ((investment.balance ?? 0) !== 0) return null

  let purchases = 0
  let sales = 0
  for (const movement of movements) {
    if (movement.type === 'BUY') purchases += Math.abs(movement.amount ?? 0)
    else if (movement.type === 'SELL') sales += Math.abs(movement.amount ?? 0)
  }

  if (purchases === 0) return null
  const unmatched = purchases - sales
  if (unmatched <= 0) return null

  return {
    name: investment.name,
    purchased: unmatched,
    currency: investment.currencyCode ?? 'BRL',
  }
}
