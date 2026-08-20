/**
 * Calendar dates and period parsing.
 *
 * Pluggy returns real instants, not UTC-midnight calendar dates. Measured on
 * 1,595 real transactions, slicing the ISO string puts 4.3% of them on the wrong
 * day - every late-evening purchase, pushed forward. So a "date" here always
 * means the calendar day the account holder would recognise, resolved in their
 * own zone. See DESIGN.md for the measurement.
 */

export type Period = {
  /** Inclusive lower bound, as an instant. */
  from: Date
  /** Inclusive upper bound, as an instant (end of the last day). */
  to: Date
  /** Human-readable form, echoed back so the model can see what it actually got. */
  label: string
}

const DAY_MS = 86_400_000

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    return found ? Number(found.value) : 0
  }
  // 'en-US' with hour12:false renders midnight as 24, not 0. The milliseconds are
  // carried over from the instant: formatToParts drops them, and without this the
  // .999 of an end-of-day boundary leaks into the offset and shifts the day.
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
    instant.getUTCMilliseconds(),
  )
  return asIfUtc - instant.getTime()
}

/**
 * Turns a wall-clock time in `timeZone` into the instant it refers to.
 *
 * The offset is applied twice because the first guess is evaluated at the wrong
 * instant near a DST boundary. Brazil no longer observes DST, but the server
 * accepts any zone through MCP_TIMEZONE.
 */
export function zonedToInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const firstPass = naive - offsetMs(new Date(naive), timeZone)
  const secondPass = naive - offsetMs(new Date(firstPass), timeZone)
  return new Date(secondPass)
}

/** Builds the `YYYY-MM-DD` formatter used for every date the model sees. */
export function calendarDateFormatter(timeZone: string): (d: Date | string) => string {
  // 'en-CA' renders as YYYY-MM-DD, which sorts lexicographically.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return (d) => fmt.format(typeof d === 'string' ? new Date(d) : d)
}

function endOfDay(timeZone: string, year: number, month: number, day: number): Date {
  return zonedToInstant(timeZone, year, month, day, 23, 59, 59, 999)
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function todayParts(timeZone: string): { year: number; month: number; day: number } {
  const iso = calendarDateFormatter(timeZone)(new Date())
  const [y, m, d] = iso.split('-').map(Number)
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 }
}

const YEAR = /^(\d{4})$/
const MONTH = /^(\d{4})-(\d{2})$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/
const RELATIVE = /^last(\d+)([dmy])$/i

/**
 * Parses a period specification into instants at zone boundaries.
 *
 * Accepts `2026`, `2026-03`, `2026-03-14`, `2026-03-01..2026-04-15`, and
 * `last90d` / `last6m` / `last2y`. Defaults to the last 90 days.
 *
 * Boundaries matter: asking for `2026-03` must not sweep in a transaction
 * stamped 1 March 00:30 UTC, which is 28 February locally.
 */
export function parsePeriod(spec: string | undefined, timeZone: string): Period {
  const raw = (spec ?? '').trim()
  if (!raw) return parsePeriod('last90d', timeZone)

  const year = YEAR.exec(raw)
  if (year) {
    const y = Number(year[1])
    return {
      from: zonedToInstant(timeZone, y, 1, 1),
      to: endOfDay(timeZone, y, 12, 31),
      label: String(y),
    }
  }

  const month = MONTH.exec(raw)
  if (month) {
    const y = Number(month[1])
    const m = Number(month[2])
    if (m < 1 || m > 12) throw new Error(`Invalid month in period: ${raw}`)
    return {
      from: zonedToInstant(timeZone, y, m, 1),
      to: endOfDay(timeZone, y, m, lastDayOfMonth(y, m)),
      label: raw,
    }
  }

  const day = DAY.exec(raw)
  if (day) {
    const y = Number(day[1])
    const m = Number(day[2])
    const d = Number(day[3])
    return { from: zonedToInstant(timeZone, y, m, d), to: endOfDay(timeZone, y, m, d), label: raw }
  }

  const range = RANGE.exec(raw)
  if (range) {
    const start = DAY.exec(range[1] ?? '')
    const end = DAY.exec(range[2] ?? '')
    if (!start || !end) throw new Error(`Invalid range: ${raw}`)
    const from = zonedToInstant(timeZone, Number(start[1]), Number(start[2]), Number(start[3]))
    const to = endOfDay(timeZone, Number(end[1]), Number(end[2]), Number(end[3]))
    if (to < from) throw new Error(`Period ends before it starts: ${raw}`)
    return { from, to, label: raw }
  }

  const relative = RELATIVE.exec(raw)
  if (relative) {
    const n = Number(relative[1])
    const unit = (relative[2] ?? 'd').toLowerCase()
    const t = todayParts(timeZone)
    const to = endOfDay(timeZone, t.year, t.month, t.day)
    if (unit === 'd') {
      const from = new Date(zonedToInstant(timeZone, t.year, t.month, t.day).getTime() - (n - 1) * DAY_MS)
      return { from, to, label: `last ${n} days` }
    }
    const monthsBack = unit === 'y' ? n * 12 : n
    const target = new Date(Date.UTC(t.year, t.month - 1 - monthsBack, 1))
    const ty = target.getUTCFullYear()
    const tm = target.getUTCMonth() + 1
    const from = zonedToInstant(timeZone, ty, tm, Math.min(t.day, lastDayOfMonth(ty, tm)))
    return { from, to, label: unit === 'y' ? `last ${n} years` : `last ${n} months` }
  }

  throw new Error(
    `Unrecognised period: ${JSON.stringify(raw)}. Use YYYY, YYYY-MM, YYYY-MM-DD, YYYY-MM-DD..YYYY-MM-DD, or last30d / last6m / last2y.`,
  )
}
