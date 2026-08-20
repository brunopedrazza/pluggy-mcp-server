/**
 * TSV rendering.
 *
 * Tab-separated because it is the cheapest shape a model reads reliably: a
 * transaction costs ~18 tokens here against ~396 as raw Pluggy JSON, and a year
 * of statements is the difference between 22k tokens and 475k.
 *
 * The banners are the important part. This design deliberately has no
 * server-side aggregation, so the model does the arithmetic - and the one thing
 * that must never happen is the model summing a partial result and reporting it
 * as a total. Both banners therefore print BEFORE the header row, where they
 * cannot be skimmed past.
 */

export type MissingConnection = {
  label: string
  status: string
  /** ISO date the connection was last healthy, when known. */
  since?: string | undefined
}

export type TsvOptions = {
  /** Set when rows were cut. `total` is the true count for the query. */
  truncated?: { shown: number; total: number; hint?: string | undefined } | undefined
  /** Connections excluded from these rows because they are not usable. */
  missing?: MissingConnection[] | undefined
  /** Echoed so the model can confirm the window it actually received. */
  period?: string | undefined
  /** Further warnings about what these rows do not contain. */
  notes?: string[] | undefined
}

export type Cell = string | number | null | undefined

/** Tabs and newlines inside a value would silently shift every later column. */
function cell(value: Cell): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\t\r\n]+/g, ' ')
}

function truncationBanner(t: NonNullable<TsvOptions['truncated']>): string {
  const hint = t.hint ? ` ${t.hint}` : ''
  return [
    `PARCIAL: ${t.total} linhas no periodo, mostrando ${t.shown}.`,
    `NAO some estas linhas como total do periodo - o resultado seria menor que o real.`,
    `Estreite o periodo ou filtre por conta para obter um total completo.${hint}`,
  ].join('\n')
}

function missingBanner(missing: MissingConnection[]): string {
  const lines = missing.map((m) => {
    const since = m.since ? ` desde ${m.since}` : ''
    return `  - ${m.label}: ${m.status}${since}`
  })
  return [
    `INCOMPLETO: ${missing.length} conexao(oes) indisponivel(is). Os dados abaixo NAO as incluem.`,
    ...lines,
    `Reconecte em meu.pluggy.ai. Nao trate estes numeros como o total consolidado.`,
  ].join('\n')
}

/**
 * Renders headers and rows as TSV, prefixed by any warning banners.
 *
 * Returns a bare message instead of an empty grid when there are no rows, so the
 * model does not read a lone header as "zero spending" when it may mean "wrong
 * filter".
 */
export function renderTsv(headers: string[], rows: Cell[][], options: TsvOptions = {}): string {
  const blocks: string[] = []

  if (options.missing && options.missing.length > 0) blocks.push(missingBanner(options.missing))
  if (options.truncated) blocks.push(truncationBanner(options.truncated))
  if (options.notes) blocks.push(...options.notes)
  if (options.period) blocks.push(`Periodo: ${options.period}`)

  if (rows.length === 0) {
    blocks.push('Nenhum resultado para estes filtros.')
    return blocks.join('\n\n')
  }

  const grid = [headers.join('\t'), ...rows.map((row) => row.map(cell).join('\t'))].join('\n')
  blocks.push(grid)
  return blocks.join('\n\n')
}

/**
 * Applies the row ceiling, reporting the true total rather than hiding the cut.
 * Rows are expected to arrive already sorted, most relevant first.
 */
export function capRows<T>(rows: T[], maxRows: number): { rows: T[]; truncated: TsvOptions['truncated'] } {
  if (rows.length <= maxRows) return { rows, truncated: undefined }
  return {
    rows: rows.slice(0, maxRows),
    truncated: { shown: maxRows, total: rows.length },
  }
}
