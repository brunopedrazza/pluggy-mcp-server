/**
 * Money formatting.
 *
 * Pluggy does not guarantee two decimals: credit card bills come back with
 * values like 2431.5285 on accounts that carry foreign-currency activity.
 * Every amount reaching the model passes through here.
 */

/** Rounds half away from zero, so -0.005 and 0.005 are treated symmetrically. */
export function round2(n: number): number {
  const sign = n < 0 ? -1 : 1
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100
}

/** Fixed two-decimal rendering. Empty string for absent values, never "null". */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return ''
  return round2(n).toFixed(2)
}
